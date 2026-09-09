import SettingsForm, { type FieldDef } from "../settings/settings-form";

const FIELDS: FieldDef[] = [
  {
    key: "aiGreeting",
    label: "Greeting (first thing callers hear)",
    type: "textarea",
    source: "settings",
  },
  {
    key: "aiModel",
    label: "Claude model",
    type: "text",
    hint: "Blank uses the server default (ANTHROPIC_MODEL). e.g. claude-sonnet-5 or claude-haiku-4-5-20251001 for lower latency.",
    source: "settings",
  },
  {
    key: "ttsProvider",
    label: "Voice provider (TTS)",
    type: "select",
    options: [
      { value: "", label: "Server default" },
      { value: "Google", label: "Google" },
      { value: "Amazon", label: "Amazon" },
      { value: "ElevenLabs", label: "ElevenLabs" },
    ],
    source: "settings",
  },
  {
    key: "ttsVoice",
    label: "Voice name",
    type: "text",
    hint: "An Australian voice from the chosen provider, e.g. en-AU-Neural2-A (Google) or Olivia (Amazon). Blank uses the server default.",
    source: "settings",
  },
  { key: "ttsLanguage", label: "Language", type: "text", hint: "en-AU", source: "settings" },
  {
    key: "sttProvider",
    label: "Speech recognition provider (STT)",
    type: "select",
    options: [
      { value: "", label: "Server default" },
      { value: "Google", label: "Google" },
      { value: "Deepgram", label: "Deepgram" },
    ],
    source: "settings",
  },
  {
    key: "sttModel",
    label: "Speech model",
    type: "text",
    hint: "Optional, e.g. nova-3-general for Deepgram",
    source: "settings",
  },
  {
    key: "speechHints",
    label: "Speech hints",
    type: "textarea",
    hint: "Comma-separated words the recogniser should expect (menu item names are added automatically).",
    source: "settings",
  },
  {
    key: "fallbackBehaviour",
    label: "When the AI can't complete a call",
    type: "select",
    options: [
      { value: "take_message", label: "Save what we have + flag for staff review" },
      { value: "end_politely", label: "Apologise and end the call" },
    ],
    source: "settings",
  },
];

export default function VoiceSettingsPage() {
  return (
    <SettingsForm
      title="Voice assistant"
      intro="Voice, speech recognition and AI behaviour. Changes apply from the next call — test with Test AI or a real call afterwards."
      fields={FIELDS}
    />
  );
}
