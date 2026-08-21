// Props-driven i18n. One composition renders in three languages straight off
// this dictionary. Copy carries SPOTTER's real voice: deadpan, loud AROUND the
// numbers, never a cheerleader. No numbers live in these lines (the numbers are
// the gold Money marks, held still). Nothing self-reported ever reads "verified".
//
// Honesty holds in every language:
//  - the grandma line is the THESIS / vision, not a live cross-border claim.
//  - on-screen money is testnet play-money USDC.
//  - reward-not-wager: no bet / wager / odds language anywhere.

export type Lang = "en" | "zh" | "fil";

export type Dict = {
  // Scene 1 - the hook (grandma cross-border thesis)
  hookLine1: string;
  hookLine2: string;
  thesisVision: string; // small honest label under the thesis
  // Scene 2 - meet SPOTTER
  spotterName: string;
  spotterTagline: string;
  spotterLineMeet: string;
  // Scene 3 - how it works, 3 beats
  step1: string;
  step2: string;
  step3: string;
  step1Sub: string;
  step2Sub: string;
  step3Sub: string;
  spotterLineHow: string;
  // Scene 4 - THE DROP
  dropLabel: string;
  dropVerified: string; // trust ribbon (verified tier)
  dropPrivacy: string;
  spotterLineDrop: string;
  // Scene 5 - THE CURRENT
  currentLabel: string;
  currentSub: string;
  spotterLineCurrent: string;
  // Scene 6 - CTA
  ctaHeadline: string;
  ctaUrl: string;
  testnetNote: string;
};

export const dict: Record<Lang, Dict> = {
  en: {
    hookLine1: "You can't Venmo your grandma in another country",
    hookLine2: "to go for a walk.",
    thesisVision: "the vision",
    spotterName: "SPOTTER",
    spotterTagline: "the GoHealthMe otter",
    spotterLineMeet: "I run the money. I don't do vibes.",
    step1: "A sponsor funds a pool",
    step2: "You hit the goal",
    step3: "You get paid",
    step1Sub: "real USDC, sitting there",
    step2Sub: "verified privately in a TEE",
    step3Sub: "the second it's verified",
    spotterLineHow: "Three steps. I only care about the last one.",
    dropLabel: "THE DROP",
    dropVerified: "Verified",
    dropPrivacy: "Verified privately. The health category is never shown.",
    spotterLineDrop: "That moved. On-chain. Not a screenshot.",
    currentLabel: "THE CURRENT",
    currentSub: "every payout, the second it lands",
    spotterLineCurrent: "This is other people getting paid. Live.",
    ctaHeadline: "Get paid to be healthy.",
    ctaUrl: "gohealthme.app",
    testnetNote: "Testnet USDC. Real chain, play money.",
  },
  zh: {
    hookLine1: "你没法给国外的奶奶发个红包",
    hookLine2: "让她出门散个步。",
    thesisVision: "愿景",
    spotterName: "SPOTTER",
    spotterTagline: "GoHealthMe 的水獭",
    spotterLineMeet: "钱由我来管。我不讲情怀。",
    step1: "赞助方注入奖金池",
    step2: "你完成目标",
    step3: "你立刻拿钱",
    step1Sub: "真实 USDC，就在那儿",
    step2Sub: "在 TEE 中私密验证",
    step3Sub: "验证通过的那一秒",
    spotterLineHow: "三步。我只在乎最后一步。",
    dropLabel: "到账时刻",
    dropVerified: "已验证",
    dropPrivacy: "私密验证。健康类别从不外露。",
    spotterLineDrop: "钱动了。上链了。不是截图。",
    currentLabel: "资金流",
    currentSub: "每一笔到账，落地即现",
    spotterLineCurrent: "这是别人正在拿钱。实时的。",
    ctaHeadline: "健康，就有回报。",
    ctaUrl: "gohealthme.app",
    testnetNote: "测试网 USDC。真链，测试币。",
  },
  fil: {
    hookLine1: "Hindi mo ma-Venmo ang lola mo sa ibang bansa",
    hookLine2: "para lang maglakad-lakad.",
    thesisVision: "ang bisyon",
    spotterName: "SPOTTER",
    spotterTagline: "ang otter ng GoHealthMe",
    spotterLineMeet: "Ako ang humahawak ng pera. Walang drama.",
    step1: "May sponsor na naglagay sa pool",
    step2: "Naabot mo ang goal",
    step3: "Babayaran ka agad",
    step1Sub: "tunay na USDC, nakaupo lang",
    step2Sub: "pribadong na-verify sa TEE",
    step3Sub: "sa mismong segundong na-verify",
    spotterLineHow: "Tatlong hakbang. Yung huli lang ang mahalaga sa akin.",
    dropLabel: "ANG DROP",
    dropVerified: "Na-verify",
    dropPrivacy: "Pribadong na-verify. Hindi kailanman ipinapakita ang kategorya.",
    spotterLineDrop: "Gumalaw yan. On-chain. Hindi screenshot.",
    currentLabel: "ANG AGOS",
    currentSub: "bawat bayad, sa mismong pagdating",
    spotterLineCurrent: "Iba na 'to na binabayaran. Live.",
    ctaHeadline: "Kumita sa pagiging healthy.",
    ctaUrl: "gohealthme.app",
    testnetNote: "Testnet USDC. Totoong chain, pang-demo na pera.",
  },
};
