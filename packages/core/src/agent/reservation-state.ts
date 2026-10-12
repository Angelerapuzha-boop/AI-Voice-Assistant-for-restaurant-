import type { Reservation } from "../types";
import { normaliseDate, normaliseTime } from "../domain/reservation-time";
import type { AvailabilityResult } from "../domain/reservations";
import { interpretPartySize, parseName, parseSpelledName, parsePhone } from "./reservation-parse";
import type { BookingField, Correction, EntityMention, Interpretation } from "./reservation-interpreter";

/**
 * THE RESERVATION STATE MANAGER (Kevin 2026-10-08 re-architecture).
 *
 * The deterministic half of "AI understands, CODE controls". It consumes the
 * LLM interpreter's structured output and owns the one source of truth about the
 * booking. Every field carries PROVENANCE — value, confidence, the utterance it
 * came from, the turn, a REVISION number, and whether it's been confirmed — so
 * we can always say why a value is what it is. Rules the machine enforces:
 *
 *  - LATEST CORRECTION ALWAYS WINS. A correction bumps the field's revision and
 *    clears its confirmed flag; the old value never resurfaces.
 *  - STALE-AVAILABILITY INVALIDATION. Any change to date, time or party throws
 *    away a cached availability result (it was for the old slot) and un-confirms
 *    the slot, so we never book a table we checked for a different request.
 *  - CONSISTENCY CHECK. Before anyone says "you're booked", the confirmed
 *    in-memory state is compared field-by-field to the actual DB row; a mismatch
 *    blocks the confirmation. No false "all set".
 *
 * The LLM never computes a value: it hands over verbatim phrases and this module
 * resolves them with the existing, battle-tested parsers.
 */

export interface ParseContext {
  now: () => Date;
  timezone: string;
  maxAdvanceDays: number;
  /** Opening window (minutes from midnight; close may exceed 1440 for a past-midnight
   * close) so a bare ambiguous hour is read as the in-hours time (e.g. 23:30 not 11:30 AM). */
  timeWindow?: { openMin: number; closeMin: number };
}

export type FieldName = "date" | "time" | "partySize" | "name" | "phone";

export interface FieldProvenance<T> {
  value: T;
  confidence: number;
  /** The exact utterance this value was taken from. */
  sourceUtterance: string;
  /** Turn index the value was set/last changed on. */
  turn: number;
  /** 1 on first capture, +1 on every subsequent change (corrections included). */
  revision: number;
  /** The caller has explicitly confirmed this value (or the whole booking). */
  confirmed: boolean;
}

export interface Fields {
  date?: FieldProvenance<string>; // ISO YYYY-MM-DD
  time?: FieldProvenance<string>; // HH:MM 24h
  partySize?: FieldProvenance<number>;
  name?: FieldProvenance<string>;
  phone?: FieldProvenance<string>; // E.164
}

export interface Resolution {
  field: FieldName;
  kind: "set" | "corrected" | "unchanged";
  value: string | number;
  previous?: string | number;
  confidence: number;
  /** Low-confidence / "candidate" value — the controller should read it back
   * (confirm the party size, repeat/spell the name) before relying on it. */
  needsConfirm: boolean;
  revision: number;
}

export type ResolutionReason =
  | "invalid_date" | "past_date" | "too_far" | "ambiguous_date"
  | "invalid_time" | "ambiguous_time"
  | "ambiguous_party"
  | "unparseable";

export interface ResolutionProblem {
  field: FieldName;
  reason: ResolutionReason;
  phrase: string;
  /** Options to offer the caller for an ambiguous value. */
  dateOptions?: { label: string; date: string }[];
  timeOptions?: { label: string; time: string }[];
  partyOptions?: number[];
}

export interface ApplyResult {
  resolutions: Resolution[];
  problems: ResolutionProblem[];
  /** True if this application changed date/time/party (availability now stale). */
  slotChanged: boolean;
}

export interface Mismatch {
  field: FieldName;
  expected: string | number;
  actual: string | number;
}

const FIELD_MAP: Record<BookingField, FieldName> = {
  date: "date",
  time: "time",
  party_size: "partySize",
  name: "name",
  phone: "phone",
};

/** A value we're confident enough in to not read back. Names below this are
 * spelled/repeated; party "candidates" are confirmed regardless. */
const NAME_CONFIRM_THRESHOLD = 0.75;

export class ReservationStateManager {
  readonly fields: Fields = {};
  /** The live DB reservation once created, so modifies/consistency can use it. */
  reservation: Reservation | null = null;

  private availability: { signature: string; result: AvailabilityResult } | null = null;

  constructor(private readonly ctx: ParseContext) {}

  // --------------------------------------------------------------- apply

  /**
   * Fold one interpreter result into the booking. Resolves every entity and
   * correction phrase to a concrete value (or a problem the controller will
   * ask about), updating provenance and invalidating stale availability.
   */
  apply(interp: Interpretation, utterance: string, turn: number, opts: { expectingParty?: boolean } = {}): ApplyResult {
    const resolutions: Resolution[] = [];
    const problems: ResolutionProblem[] = [];
    let slotChanged = false;

    // Corrections first and with priority: if the caller both "mentions" and
    // "corrects" the same field in one breath, the correction is the truth.
    const corrected = new Set<FieldName>();
    for (const c of interp.corrections) {
      const field = FIELD_MAP[c.field];
      const r = this.resolveAndSet(field, c.phrase, c.confidence, utterance, turn, true, opts, problems);
      if (r) {
        resolutions.push(r);
        corrected.add(field);
        if (field === "date" || field === "time" || field === "partySize") slotChanged = true;
      }
    }

    for (const [bf, mention] of Object.entries(interp.entities) as [BookingField, EntityMention][]) {
      if (!mention) continue;
      const field = FIELD_MAP[bf];
      if (corrected.has(field)) continue; // correction already won this turn
      const r = this.resolveAndSet(field, mention.phrase, mention.confidence, utterance, turn, false, opts, problems);
      if (r) {
        resolutions.push(r);
        if (r.kind !== "unchanged" && (field === "date" || field === "time" || field === "partySize")) {
          slotChanged = true;
        }
      }
    }

    if (slotChanged) this.invalidateAvailability();
    return { resolutions, problems, slotChanged };
  }

  private resolveAndSet(
    field: FieldName,
    phrase: string,
    confidence: number,
    utterance: string,
    turn: number,
    isCorrection: boolean,
    opts: { expectingParty?: boolean },
    problems: ResolutionProblem[],
  ): Resolution | null {
    switch (field) {
      case "date": {
        const r = normaliseDate(phrase, {
          now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.maxAdvanceDays,
        });
        if (r.date) return this.setField("date", r.date, confidence, utterance, turn, isCorrection, false);
        if (r.ambiguous?.length) problems.push({ field, reason: "ambiguous_date", phrase, dateOptions: r.ambiguous });
        else if (r.error === "PAST") problems.push({ field, reason: "past_date", phrase });
        else if (r.error === "TOO_FAR") problems.push({ field, reason: "too_far", phrase });
        else problems.push({ field, reason: "invalid_date", phrase });
        return null;
      }
      case "time": {
        const r = normaliseTime(phrase, this.ctx.timeWindow);
        if (r.time) return this.setField("time", r.time, confidence, utterance, turn, isCorrection, false);
        if (r.ambiguous?.length) problems.push({ field, reason: "ambiguous_time", phrase, timeOptions: r.ambiguous });
        else problems.push({ field, reason: "invalid_time", phrase });
        return null;
      }
      case "partySize": {
        // The interpreter already attributed this phrase to the party, so we ARE
        // expecting a count — bare "four" resolves to a firm value, not a candidate.
        void opts;
        const r = interpretPartySize(phrase, { expectingParty: true });
        if (r.kind === "value") return this.setField("partySize", r.value, confidence, utterance, turn, isCorrection, false);
        if (r.kind === "candidate") return this.setField("partySize", r.value, Math.min(confidence, 0.6), utterance, turn, isCorrection, true);
        if (r.kind === "ambiguous") problems.push({ field, reason: "ambiguous_party", phrase, partyOptions: r.options });
        else problems.push({ field, reason: "unparseable", phrase });
        return null;
      }
      case "name": {
        // Prefer the SPELLING parse when the caller spelled it in the same breath
        // ("Zara, Z-A-R-A" / "Jai, J for juliet…") — parseSpelledName returns the clean
        // name and is null for a plain name, so a plain name still flows to parseName.
        // Without this, parseName captured the spelling tokens too ("Zara Z-a-r-a").
        const name = parseSpelledName(phrase) ?? parseName(phrase) ?? cleanBareName(phrase);
        if (name) {
          const needsConfirm = confidence < NAME_CONFIRM_THRESHOLD;
          return this.setField("name", name, confidence, utterance, turn, isCorrection, needsConfirm);
        }
        problems.push({ field, reason: "unparseable", phrase });
        return null;
      }
      case "phone": {
        const phone = parsePhone(phrase);
        if (phone) return this.setField("phone", phone, confidence, utterance, turn, isCorrection, false);
        problems.push({ field, reason: "unparseable", phrase });
        return null;
      }
    }
  }

  private setField<K extends FieldName>(
    field: K,
    value: string | number,
    confidence: number,
    utterance: string,
    turn: number,
    isCorrection: boolean,
    needsConfirm: boolean,
  ): Resolution {
    const existing = this.fields[field] as FieldProvenance<string | number> | undefined;
    const same = existing && existing.value === value;
    // Same value restated (not a correction): keep it, refresh confidence/turn,
    // don't bump the revision or un-confirm.
    if (same && !isCorrection) {
      existing!.confidence = Math.max(existing!.confidence, confidence);
      return { field, kind: "unchanged", value, confidence: existing!.confidence, needsConfirm: false, revision: existing!.revision };
    }
    const previous = existing?.value;
    const revision = (existing?.revision ?? 0) + 1;
    const prov: FieldProvenance<string | number> = {
      value, confidence, sourceUtterance: utterance, turn, revision, confirmed: false,
    };
    (this.fields as Record<string, FieldProvenance<string | number>>)[field] = prov;
    return {
      field,
      kind: existing ? "corrected" : "set",
      value,
      previous,
      confidence,
      needsConfirm,
      revision,
    };
  }

  // --------------------------------------------------------------- confirmation

  /** Set the phone directly from a trusted source (the caller ID), bypassing the
   * phrase parser — used when the caller says "just use the number I'm calling
   * from". Marked confirmed; bumps the revision like any other change. */
  setPhone(phone: string, utterance: string, turn: number): void {
    const existing = this.fields.phone;
    if (existing && existing.value === phone) { existing.confirmed = true; return; }
    this.fields.phone = {
      value: phone, confidence: 1, sourceUtterance: utterance, turn,
      revision: (existing?.revision ?? 0) + 1, confirmed: true,
    };
  }

  /** Drop a captured field entirely (e.g. a time that fell outside opening hours),
   * and invalidate any cached availability so the next value is re-checked fresh. */
  clearField(field: FieldName): void {
    delete this.fields[field];
    this.availability = null;
  }

  /** Flag a just-captured value as UNCERTAIN (the interpreter wasn't sure it heard it
   * right — e.g. a name on a noisy line). Drops its confidence below the read-back
   * threshold and un-confirms it, so the controller confirms/spells it rather than
   * trusting it (Kevin 2026-10-10: uncertainty is clarified, never guessed). */
  markUncertain(field: FieldName): void {
    const f = this.fields[field] as FieldProvenance<string | number> | undefined;
    if (f) { f.confidence = Math.min(f.confidence, 0.5); f.confirmed = false; }
  }

  /** Mark a field as explicitly confirmed by the caller. */
  confirmField(field: FieldName): void {
    const f = this.fields[field] as FieldProvenance<string | number> | undefined;
    if (f) f.confirmed = true;
  }

  /** Mark every present field confirmed (caller approved the whole booking). */
  confirmAll(): void {
    for (const k of Object.keys(this.fields) as FieldName[]) this.confirmField(k);
  }

  // --------------------------------------------------------------- availability

  private slotSignature(): string {
    return `${this.fields.date?.value ?? ""}|${this.fields.time?.value ?? ""}|${this.fields.partySize?.value ?? ""}`;
  }

  /** Cache an availability result against the CURRENT slot signature. */
  setAvailability(result: AvailabilityResult): void {
    this.availability = { signature: this.slotSignature(), result };
  }

  /** The cached availability result, but only if it's still for the current
   * date/time/party. Any change since the check returns null (stale). */
  freshAvailability(): AvailabilityResult | null {
    if (!this.availability) return null;
    return this.availability.signature === this.slotSignature() ? this.availability.result : null;
  }

  invalidateAvailability(): void {
    this.availability = null;
    // A slot change un-confirms the slot fields — the caller approved the OLD slot.
    for (const k of ["date", "time", "partySize"] as FieldName[]) {
      const f = this.fields[k] as FieldProvenance<string | number> | undefined;
      if (f) f.confirmed = false;
    }
  }

  // --------------------------------------------------------------- completeness

  hasSlot(): boolean {
    return !!(this.fields.date && this.fields.time && this.fields.partySize);
  }

  /** The next required field still missing, in the natural asking order, or null
   * when everything needed to book is present. Phone is optional when a caller-ID
   * number is supplied separately (the controller decides). */
  nextMissing(opts: { needPhone: boolean; skipName?: boolean }): FieldName | null {
    if (!this.fields.date) return "date";
    if (!this.fields.time) return "time";
    if (!this.fields.partySize) return "partySize";
    if (!opts.skipName && !this.fields.name) return "name";
    if (opts.needPhone && !this.fields.phone) return "phone";
    return null;
  }

  values(): { date?: string; time?: string; partySize?: number; name?: string; phone?: string } {
    return {
      date: this.fields.date?.value,
      time: this.fields.time?.value,
      partySize: this.fields.partySize?.value,
      name: this.fields.name?.value,
      phone: this.fields.phone?.value,
    };
  }

  // --------------------------------------------------------------- consistency

  /**
   * Compare the confirmed in-memory booking to an actual DB reservation row.
   * Returns the fields that DON'T match. The controller must never tell the
   * caller they're booked while this is non-empty (Kevin: no false confirmations).
   */
  consistencyCheck(res: Reservation): Mismatch[] {
    const out: Mismatch[] = [];
    const v = this.values();
    if (v.date && res.reservationDate !== v.date) {
      out.push({ field: "date", expected: v.date, actual: String(res.reservationDate) });
    }
    if (v.time) {
      const dbTime = String(res.reservationTime).slice(0, 5);
      if (dbTime !== v.time) out.push({ field: "time", expected: v.time, actual: dbTime });
    }
    if (v.partySize && res.partySize !== v.partySize) {
      out.push({ field: "partySize", expected: v.partySize, actual: res.partySize });
    }
    if (v.name && res.customerName && normname(res.customerName) !== normname(v.name)) {
      out.push({ field: "name", expected: v.name, actual: res.customerName });
    }
    return out;
  }

  /** Internal snapshot for per-turn debug logging. */
  snapshot(): Record<string, unknown> {
    const f: Record<string, unknown> = {};
    for (const k of Object.keys(this.fields) as FieldName[]) {
      const p = this.fields[k] as FieldProvenance<string | number> | undefined;
      if (p) f[k] = { value: p.value, rev: p.revision, conf: Number(p.confidence.toFixed(2)), confirmed: p.confirmed };
    }
    return { fields: f, availabilityFresh: this.freshAvailability() !== null };
  }
}

/** A phrase the interpreter tagged as a name but parseName rejected (e.g. a bare
 * unusual first name). Accept a short, purely-alphabetic phrase, title-cased. */
function cleanBareName(phrase: string): string | null {
  const words = phrase.trim().split(/\s+/).filter((w) => /^[a-zA-Z'’-]{2,}$/.test(w));
  if (words.length === 0 || words.length > 4) return null;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Loose name comparison for the consistency check — case/space-insensitive. */
const normname = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
