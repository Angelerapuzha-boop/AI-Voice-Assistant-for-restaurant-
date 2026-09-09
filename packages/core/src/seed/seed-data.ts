/**
 * Meatbox WA seed menu.
 *
 * Items and prices marked [site] were taken from meatboxwa.com.au on
 * 2026-09-09. Everything else is REPRESENTATIVE ([rep]) and must be
 * reviewed and corrected by the restaurant owner before launch —
 * see LAUNCH_CHECKLIST.md. All of it is editable in Admin > Menu.
 */

export interface SeedModifier {
  name: string;
  priceCents?: number;
}

export interface SeedGroup {
  name: string;
  required?: boolean;
  minSelect?: number;
  maxSelect?: number;
  modifiers: SeedModifier[];
}

export interface SeedItem {
  name: string;
  description: string;
  priceCents: number;
  vegetarian?: boolean;
  popular?: boolean;
  aliases?: string[];
  groups?: SeedGroup[];
}

export interface SeedCategory {
  name: string;
  slug: string;
  description?: string;
  items: SeedItem[];
}

const SAUCES: SeedGroup = {
  name: "Sauces",
  maxSelect: 3,
  modifiers: [
    { name: "Garlic sauce" },
    { name: "Chilli sauce" },
    { name: "BBQ sauce" },
    { name: "Tomato sauce" },
    { name: "Sweet chilli sauce" },
    { name: "Tahini sauce" },
  ],
};

const EXTRAS: SeedGroup = {
  name: "Extras",
  maxSelect: 4,
  modifiers: [
    { name: "Extra meat", priceCents: 500 },
    { name: "Extra chips", priceCents: 400 },
    { name: "Cheese", priceCents: 150 },
    { name: "Halloumi", priceCents: 400 },
    { name: "Extra garlic dip", priceCents: 250 },
  ],
};

const BASE_CHOICE: SeedGroup = {
  name: "Base",
  required: true,
  maxSelect: 1,
  modifiers: [{ name: "Chips & Salad" }, { name: "Rice & Salad" }],
};

const SALAD_CHOICE: SeedGroup = {
  name: "Salads",
  maxSelect: 5,
  modifiers: [
    { name: "Lettuce" },
    { name: "Tomato" },
    { name: "Onion" },
    { name: "Tabouli" },
    { name: "Pickles" },
  ],
};

export const SEED_CATEGORIES: SeedCategory[] = [
  {
    name: "Meatbox",
    slug: "meatbox",
    description: "Our signature boxes — marinated meat over your choice of base.",
    items: [
      {
        name: "Chicken Meatbox",
        description:
          "Marinated chicken over your choice of chips & salad or rice & salad. [site $19.95]",
        priceCents: 1995,
        popular: true,
        aliases: ["chic meatbox", "chicken meat box", "chicken box"],
        groups: [BASE_CHOICE, SAUCES, EXTRAS],
      },
      {
        name: "Lamb Meatbox",
        description:
          "Marinated lamb over your choice of chips & salad or rice & salad. [site $19.95]",
        priceCents: 1995,
        popular: true,
        aliases: ["lamb meat box", "lamb box"],
        groups: [BASE_CHOICE, SAUCES, EXTRAS],
      },
      {
        name: "Mixed Meatbox",
        description: "Half chicken, half lamb over your choice of base. [rep]",
        priceCents: 2195,
        aliases: ["mixed meat box", "mixed box", "mix box"],
        groups: [BASE_CHOICE, SAUCES, EXTRAS],
      },
      {
        name: "Small Meatbox",
        description: "A smaller serve of our signature box, choose your meat and base. [rep]",
        priceCents: 1495,
        aliases: ["small meat box", "small box", "kids box"],
        groups: [
          {
            name: "Meat choice",
            required: true,
            maxSelect: 1,
            modifiers: [{ name: "Chicken" }, { name: "Lamb" }, { name: "Mixed" }],
          },
          BASE_CHOICE,
          SAUCES,
        ],
      },
    ],
  },
  {
    name: "Kebabs & Rolls",
    slug: "kebabs",
    description: "Fresh baked bread, salads and sauces.",
    items: [
      {
        name: "Chicken Kebab",
        description: "Marinated chicken with salads and sauce in fresh bread. [rep]",
        priceCents: 1295,
        popular: true,
        aliases: ["chicken kebab roll", "chicken wrap"],
        groups: [SALAD_CHOICE, SAUCES, EXTRAS],
      },
      {
        name: "Lamb Kebab",
        description: "Marinated lamb with salads and sauce in fresh bread. [rep]",
        priceCents: 1395,
        aliases: ["lamb kebab roll", "lamb wrap"],
        groups: [SALAD_CHOICE, SAUCES, EXTRAS],
      },
      {
        name: "Mixed Kebab",
        description: "Chicken and lamb with salads and sauce in fresh bread. [rep]",
        priceCents: 1395,
        aliases: ["mixed kebab roll", "mix kebab"],
        groups: [SALAD_CHOICE, SAUCES, EXTRAS],
      },
      {
        name: "Falafel Kebab",
        description: "House-made falafel with salads and sauce. Vegetarian. [site $11.95]",
        priceCents: 1195,
        vegetarian: true,
        aliases: ["falafel roll", "felafel kebab"],
        groups: [SALAD_CHOICE, SAUCES],
      },
    ],
  },
  {
    name: "Charcoal Chicken",
    slug: "charcoal-chicken",
    items: [
      {
        name: "Half Charcoal Chicken Meal",
        description: "Half charcoal chicken with chips, garlic dip and bread. [site $23.95]",
        priceCents: 2395,
        popular: true,
        aliases: ["half chicken meal", "half charcoal chicken in a meal"],
        groups: [SAUCES],
      },
      {
        name: "Whole Charcoal Chicken",
        description: "Whole charcoal chicken, marinated and slow roasted. [rep]",
        priceCents: 2695,
        aliases: ["whole chicken", "full chicken"],
        groups: [SAUCES],
      },
      {
        name: "Quarter Chicken & Chips",
        description: "Quarter charcoal chicken with chips. [rep]",
        priceCents: 1495,
        aliases: ["quarter chicken"],
        groups: [SAUCES],
      },
    ],
  },
  {
    name: "Off the Grill",
    slug: "grill",
    description: "Charcoal grilled skewers and plates.",
    items: [
      {
        name: "Mixed Grill (4 skewers)",
        description:
          "Four charcoal skewers with your choice of rice & salad or chips & salad. [site $29.95]",
        priceCents: 2995,
        popular: true,
        aliases: ["mixed grill", "4 skewers"],
        groups: [BASE_CHOICE, SAUCES],
      },
      {
        name: "Grill Platter (8 skewers)",
        description: "Eight skewers with rice, salad, garlic dip and hommus. [site $59.95]",
        priceCents: 5995,
        aliases: ["grill platter", "8 skewers", "family platter"],
      },
      {
        name: "Shish Taouk with Chips & Salad",
        description: "Marinated chicken skewers with chips and salad. [site $23.95]",
        priceCents: 2395,
        aliases: ["shish taouk", "shish tawook", "chicken skewers"],
        groups: [SAUCES],
      },
      {
        name: "Kafta with Chips & Salad",
        description: "Seasoned minced lamb skewers with chips and salad. [site $23.95]",
        priceCents: 2395,
        aliases: ["kafta", "kofta"],
        groups: [SAUCES],
      },
      {
        name: "Lamb Shank with Rice & Salad",
        description: "Slow-cooked lamb shank with rice and salad. [site $29.95]",
        priceCents: 2995,
        aliases: ["lamb shank"],
      },
      {
        name: "Beef Ribs Plate",
        description:
          "Beef ribs with corn cob, sweet potato chips, bread and gravy. [site $29.95]",
        priceCents: 2995,
        aliases: ["beef ribs", "ribs"],
      },
      {
        name: "Lahme Skewer",
        description: "Lamb meat skewer. [site $9.95]",
        priceCents: 995,
        aliases: ["lahme", "lamb skewer", "lahem"],
      },
    ],
  },
  {
    name: "Burgers",
    slug: "burgers",
    items: [
      {
        name: "Chicken Burger",
        description: "Grilled chicken, lettuce, tomato and garlic sauce. [rep]",
        priceCents: 1195,
        aliases: ["chicken burger"],
        groups: [SAUCES, EXTRAS],
      },
      {
        name: "Lamb Burger",
        description: "Grilled lamb, salads and sauce. [rep]",
        priceCents: 1295,
        groups: [SAUCES, EXTRAS],
      },
      {
        name: "Meatbox Burger with the Lot",
        description: "Our signature burger loaded with the lot. [rep]",
        priceCents: 1495,
        aliases: ["burger with the lot", "the lot burger"],
        groups: [SAUCES, EXTRAS],
      },
    ],
  },
  {
    name: "Gozleme & Manakish",
    slug: "gozleme-manakish",
    items: [
      {
        name: "Cheese Manakish",
        description: "Freshly baked Lebanese flatbread with cheese. Vegetarian. [site $8.95]",
        priceCents: 895,
        vegetarian: true,
        aliases: ["cheese manoush", "cheese mankoush"],
      },
      {
        name: "Zaatar Manakish",
        description: "Flatbread with zaatar and olive oil. Vegetarian. [rep]",
        priceCents: 795,
        vegetarian: true,
        aliases: ["zaatar", "zatar manakish"],
      },
      {
        name: "Lamb Pide",
        description: "Turkish bread boat topped with seasoned lamb. [site $14.95]",
        priceCents: 1495,
        aliases: ["lamb pide", "pide"],
      },
      {
        name: "Chicken Pizza",
        description: "Chicken pizza on fresh baked base. [site $20.00]",
        priceCents: 2000,
        aliases: ["chicken pizza"],
      },
      {
        name: "Spinach & Cheese Gozleme",
        description: "Hand-rolled gozleme with spinach and cheese. Vegetarian. [rep]",
        priceCents: 1395,
        vegetarian: true,
        aliases: ["spinach gozleme", "cheese gozleme", "vegetarian gozleme"],
      },
      {
        name: "Lamb Gozleme",
        description: "Hand-rolled gozleme with seasoned lamb. [rep]",
        priceCents: 1495,
        aliases: ["lamb gozleme"],
      },
    ],
  },
  {
    name: "Fish & Chips",
    slug: "fish-chips",
    items: [
      {
        name: "Fish & Chips (3 pieces NZ Cod)",
        description: "Three pieces of New Zealand cod with chips. [site $14.95]",
        priceCents: 1495,
        aliases: ["fish and chips", "fish n chips"],
        groups: [SAUCES],
      },
    ],
  },
  {
    name: "Sides",
    slug: "sides",
    items: [
      {
        name: "Chips",
        description: "Golden fried chips with chicken salt. Vegetarian. [rep]",
        priceCents: 600,
        vegetarian: true,
        aliases: ["hot chips", "fries"],
        groups: [
          {
            name: "Size",
            required: true,
            maxSelect: 1,
            modifiers: [{ name: "Small" }, { name: "Large", priceCents: 300 }],
          },
          SAUCES,
        ],
      },
      {
        name: "Garlic Bread",
        description: "Toasted garlic bread. Vegetarian. [rep]",
        priceCents: 400,
        vegetarian: true,
      },
      {
        name: "Rice",
        description: "Seasoned rice. Vegetarian. [rep]",
        priceCents: 500,
        vegetarian: true,
      },
      {
        name: "Tabouli",
        description: "Fresh parsley salad. Vegetarian. [rep]",
        priceCents: 600,
        vegetarian: true,
        aliases: ["tabbouleh"],
      },
      {
        name: "Falafel (4 pieces)",
        description: "Four house-made falafel. Vegetarian. [rep]",
        priceCents: 600,
        vegetarian: true,
        aliases: ["falafel pieces", "felafel"],
      },
    ],
  },
  {
    name: "Dips & Sauces",
    slug: "dips",
    items: [
      {
        name: "Garlic Dip",
        description: "House-made garlic dip. Vegetarian. [rep]",
        priceCents: 250,
        vegetarian: true,
        aliases: ["garlic tub", "toum"],
      },
      {
        name: "Hummus",
        description: "House-made hummus. Vegetarian. [rep]",
        priceCents: 300,
        vegetarian: true,
        aliases: ["hommus", "houmous"],
      },
      {
        name: "Chilli Dip",
        description: "House-made chilli dip. Vegetarian. [rep]",
        priceCents: 250,
        vegetarian: true,
      },
      {
        name: "Tahini Dip",
        description: "Tahini sauce tub. Vegetarian. [rep]",
        priceCents: 250,
        vegetarian: true,
      },
    ],
  },
  {
    name: "Drinks",
    slug: "drinks",
    items: [
      {
        name: "Soft Drink Can",
        description: "375ml can. Vegetarian. [rep]",
        priceCents: 350,
        vegetarian: true,
        aliases: ["can of drink", "coke", "soft drink"],
        groups: [
          {
            name: "Flavour",
            required: true,
            maxSelect: 1,
            modifiers: [
              { name: "Coke" },
              { name: "Coke No Sugar" },
              { name: "Fanta" },
              { name: "Sprite" },
              { name: "Solo" },
            ],
          },
        ],
      },
      {
        name: "Soft Drink 1.25L",
        description: "1.25 litre bottle. Vegetarian. [rep]",
        priceCents: 600,
        vegetarian: true,
        aliases: ["big bottle", "large drink"],
        groups: [
          {
            name: "Flavour",
            required: true,
            maxSelect: 1,
            modifiers: [{ name: "Coke" }, { name: "Coke No Sugar" }, { name: "Fanta" }, { name: "Sprite" }],
          },
        ],
      },
      {
        name: "Water",
        description: "600ml still water. Vegetarian. [rep]",
        priceCents: 300,
        vegetarian: true,
      },
      {
        name: "Ayran",
        description: "Traditional yoghurt drink. Vegetarian. [rep]",
        priceCents: 400,
        vegetarian: true,
        aliases: ["yoghurt drink"],
      },
    ],
  },
  {
    name: "Bubble Tea",
    slug: "bubble-tea",
    items: [
      {
        name: "Classic Milk Tea",
        description: "Classic milk tea with pearls. Vegetarian. [rep]",
        priceCents: 750,
        vegetarian: true,
        aliases: ["milk tea", "boba"],
      },
      {
        name: "Taro Milk Tea",
        description: "Taro milk tea with pearls. Vegetarian. [rep]",
        priceCents: 800,
        vegetarian: true,
        aliases: ["taro tea"],
      },
      {
        name: "Mango Fruit Tea",
        description: "Mango fruit tea. Vegetarian. [rep]",
        priceCents: 800,
        vegetarian: true,
        aliases: ["mango tea"],
      },
    ],
  },
];
