// ---------------------------------------------------------------------
// SUNO PROMPT MAKER - サーバー側生成関数
//
// フロントエンドは「回答内容」だけをここへ送り、Anthropic APIキーの
// 使用・プロンプト組み立て・文字数短縮・利用回数の判定は、すべて
// この関数(サーバー側)だけで行う。APIキーはフロントエンドに一切渡さない。
//
// 利用制限:
//   ・1つのIPアドレス(ハッシュ化して保存) につき 1日3回まで
//   ・サイト全体で 1日30回まで
//   ・同じIPからの連続呼び出しを防ぐ簡易クールダウン(5秒)
// これらはすべて Netlify Blobs (サーバー側のデータ保存) で判定するため、
// 利用者のブラウザ側の操作(localStorage削除など)では解除できない。
// ---------------------------------------------------------------------

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const PER_IP_DAILY_LIMIT = 3;
const SITE_DAILY_LIMIT = 30;
const COOLDOWN_MS = 5000; // 同一IPからの連打防止(5秒)

const STYLE_PROMPT_HARD_LIMIT = 1000;
const STYLE_PROMPT_TARGET = 950;

// ---- 日付(日本時間基準。日付が変わったら自動的にキーが変わりリセットされる) ----
const todayKeyJST = () => {
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// ---- IPアドレスの取得とハッシュ化(平文のIPは保存しない) ----
const getClientIp = (event) => {
  const xff = event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"];
  const nfIp = event.headers["x-nf-client-connection-ip"];
  const raw = (nfIp || (xff ? xff.split(",")[0].trim() : "") || "unknown").trim();
  return raw;
};

const hashIp = (ip) => {
  const salt = process.env.IP_HASH_SALT || "suno-prompt-maker-default-salt";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 24);
};

// ---- 文字数カウント(Unicodeのコードポイント単位) ----
const countChars = (text) => Array.from(text || "").length;

// ---- ラベル付きセクションの解析 ----
const parseLabeledSections = (text, labels) => {
  const result = {};
  const labelRegex = new RegExp(`^(${labels.join("|")}):`, "gm");
  const matches = [...text.matchAll(labelRegex)];
  matches.forEach((m, i) => {
    const label = m[1];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    result[label] = text.slice(start, end).trim();
  });
  return result;
};

const fmt = (v) => {
  if (!v) return null;
  if (Array.isArray(v)) return v.length > 0 ? v.join("、") : null;
  const trimmed = String(v).trim();
  return trimmed ? trimmed : null;
};

// ---- ボーカル関連の日本語→英語対応表(元のArtifactと同一内容) ----
const VOCAL_EN = {
  男性: "male vocals",
  女性: "female vocals",
  男女デュエット: "male and female duet vocals",
  複数ボーカル: "multiple vocalists, group vocals",
  インストゥルメンタル: "instrumental, no vocals",
};
const VOICE_QUALITY_EN = {
  透明感のある声: "crystalline, clear voice",
  優しい声: "gentle voice",
  柔らかい声: "soft voice",
  甘い声: "sweet voice",
  ハスキー: "husky voice",
  低く落ち着いた声: "low, calm voice",
  高く澄んだ声: "high, clear voice",
  力強い声: "powerful voice",
  少し掠れた声: "slightly raspy voice",
  大人っぽい声: "mature-toned voice",
  "少年・少女のような声": "youthful voice",
};
const SINGING_STYLE_EN = {
  語りかけるように: "spoken-word-like delivery",
  優しく: "gentle delivery",
  淡々と: "understated, deadpan delivery",
  感情豊かに: "emotionally expressive delivery",
  力強く: "powerful delivery",
  激しく: "intense, aggressive delivery",
  囁くように: "whispery delivery",
  伸びやかに: "soaring, free-flowing delivery",
  サビで一気に爆発: "delivery that bursts with intensity in the chorus",
};

const buildVocalSpecText = (a) => {
  const vocalPhrase = VOCAL_EN[a.vocal];
  if (!vocalPhrase) return "";
  if (a.vocal === "インストゥルメンタル") return vocalPhrase;
  const qualities = (Array.isArray(a.voiceQuality) ? a.voiceQuality : []).map((q) => VOICE_QUALITY_EN[q]).filter(Boolean);
  const styles = (Array.isArray(a.singingStyle) ? a.singingStyle : []).map((st) => SINGING_STYLE_EN[st]).filter(Boolean);
  return [vocalPhrase, ...qualities, ...styles].join(", ");
};

// ---- 曲調プロンプト条件テキストの組み立て(元のArtifactと同一内容) ----
const buildStyleFieldsText = (a) =>
  [
    ["ジャンル", fmt(a.genre)],
    ["曲の雰囲気", fmt(a.mood)],
    ["テンポ", fmt(a.tempo)],
    ["使用したい楽器", fmt(a.instruments)],
    ["特に重点を置きたい楽器", fmt(a.instrumentEmphasis)],
    ["ボーカル", fmt(a.vocal)],
    ["声質", fmt(a.voiceQuality)],
    ["歌い方", fmt(a.singingStyle)],
    ["時代・サウンド感", fmt(a.era)],
    ["曲の展開", fmt(a.development)],
    ["参考にしたいアーティスト・楽曲(名前は出力に使わないこと)", fmt(a.referenceArtist)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `・${k}: ${v}`)
    .join("\n");

const buildPrompt = (a) => {
  const styleFields = buildStyleFieldsText(a);
  const lyricFields = [
    ["テーマ", fmt(a.theme)],
    ["主人公", fmt(a.protagonist)],
    ["誰に向けた歌か", fmt(a.addressee)],
    ["一人称", fmt(a.pov)],
    ["結末", fmt(a.ending)],
    ["歌詞の表現", fmt(a.expression)],
    ["必ず入れたい言葉・情景", fmt(a.mustInclude)],
    ["入れたくない表現", fmt(a.mustAvoid)],
    ["タイトル", a.titleMode === "自分で指定する" ? fmt(a.titleText) || "(指定なし)" : "AIが考える"],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `・${k}: ${v}`)
    .join("\n");

  return `あなたは音楽制作とSuno(AI作曲サービス)のプロンプト設計に精通した専門家です。以下はユーザーが選択式・自由入力で答えた、作りたい曲の条件です。これをもとに、2種類のプロンプトを作成してください。

【曲調についての回答】
${styleFields || "・特に指定なし"}

【歌詞についての回答】
${lyricFields || "・特に指定なし"}

【重要な考え方】
回答を単純に並べるのではなく、選ばれた項目同士の相性を考慮しながら統合し、それぞれ自然で具体的な1つのプロンプトに仕上げてください。専門知識のない利用者でも、この2つをコピーしてそのまま使えるレベルの完成度にしてください。

【① SUNO用 曲調プロンプトについて】
・自然な英語の音楽プロンプトとして書くこと(日本語は使わない)
・ジャンル・雰囲気・テンポ・楽器編成・年代感・曲の展開を、自然な英文として統合すること
・テンポの回答から、自然なBPM帯(例: "around 120 BPM"のような形)も可能な範囲で反映すること
・特定の実在アーティスト名や既存の楽曲名は、たとえ「参考にしたいアーティスト・楽曲」として与えられていても、出力する曲調プロンプトの中に一切書かないこと。名前ではなく、その音楽が持つ音楽的特徴だけを言葉にして反映すること
・「特に重点を置きたい楽器」が指定されている場合は、その楽器が編成の中で特に目立つよう、"prominent" のような強調表現を使い、他の楽器より優先的に描写すること
・ボーカル・声質・歌い方については、この後システム側で別途確実に追加されるため、無理にここで書き込む必要はない
・文字数は${STYLE_PROMPT_TARGET}字前後を目標にし、${STYLE_PROMPT_HARD_LIMIT}字を1文字でも超えてはならない絶対上限として扱うこと

【② ChatGPT用 作詞プロンプトについて】
・日本語で書くこと。ChatGPT等の生成AIにそのまま貼り付ければ、完成した歌詞を書いてもらえる、詳細な依頼文にすること
・以下を必ず指示内容に含めること: Sunoで楽曲化するための歌詞であること/テーマ/主人公/誰に向けた歌か/一人称/結末/表現方法/必ず入れたい言葉や情景/入れたくない表現/曲調との整合性/歌として自然に歌える言葉の長さとリズムを意識すること/Aメロ・Bメロ・サビなどのメリハリを意識すること/同じ説明を何度も繰り返さないこと/サビには曲を象徴する印象的なフレーズを作ること/タイトルも生成すること
・[Verse 1] [Pre-Chorus] [Chorus] [Verse 2] [Bridge] [Final Chorus] のようなセクション表記を使うよう指示に含めること
・500字程度を目安にすること

【出力形式】
STYLE_PROMPT:
(SUNO用の英語の曲調プロンプトのみ)
LYRIC_PROMPT:
(ChatGPT用の日本語の作詞プロンプトのみ)`;
};

const buildShortenStylePrompt = (overLongPrompt, styleFieldsText, limit) => {
  const target = Math.max(limit - 50, 100);
  return `以下の英語の曲調プロンプトは${limit}字を超えており、そのままでは使用できません。${target}字前後(${limit}字を1文字でも超えないこと)に短縮してください。

【短縮対象のプロンプト】
${overLongPrompt}

【もとになった条件(参考)】
${styleFieldsText || "(特になし)"}

【短縮のルール】
・優先して削るのは、重複した表現・冗長な修飾語・意味の薄い説明から
・ジャンル、BPM、雰囲気、主要楽器、曲構成など、ユーザーが選んだ重要な条件はできる限り残すこと
・単語や文の途中で切らず、自然な英文のまま短縮すること
・日本語は使わず、英語のまま書くこと

【出力形式】
STYLE_PROMPT:
(${target}字前後、${limit}字を絶対に超えない、短縮後の英語の曲調プロンプトのみ)`;
};

const smartTrimToLimit = (text, limit) => {
  const chars = Array.from(text || "");
  if (chars.length <= limit) return text;
  const cut = chars.slice(0, limit).join("");
  const boundaryChars = [".", "!", "?", ";"];
  let bestIdx = -1;
  boundaryChars.forEach((b) => {
    const idx = cut.lastIndexOf(b);
    if (idx > bestIdx) bestIdx = idx;
  });
  if (bestIdx > limit * 0.6) return cut.slice(0, bestIdx + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
};

// ---- Anthropic API 呼び出し(APIキーはここでだけ使う) ----
const callClaude = async (promptText) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: promptText }],
    }),
  });
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  const data = await response.json();
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  if (!text) throw new Error("empty response");
  return text;
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "METHOD_NOT_ALLOWED" }) };
  }

  let answers;
  try {
    const body = JSON.parse(event.body || "{}");
    answers = body.answers || {};
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "BAD_REQUEST" }) };
  }

  const ip = getClientIp(event);
  const ipHash = hashIp(ip);
  const dateKey = todayKeyJST();

  const usageStore = getStore("suno-usage");

  try {
    // --- クールダウン(同一IPの連打防止) ---
    const cooldownKey = `cooldown:${ipHash}`;
    const lastRequestRaw = await usageStore.get(cooldownKey);
    if (lastRequestRaw) {
      const elapsed = Date.now() - parseInt(lastRequestRaw, 10);
      if (elapsed < COOLDOWN_MS) {
        return {
          statusCode: 429,
          body: JSON.stringify({ error: "TOO_FAST", message: "少し間隔を空けてから、もう一度お試しください。" }),
        };
      }
    }
    await usageStore.set(cooldownKey, String(Date.now()));

    // --- 個人(IP)の1日の上限チェック ---
    const perIpKey = `count:${dateKey}:${ipHash}`;
    const perIpRaw = await usageStore.get(perIpKey);
    const perIpCount = perIpRaw ? parseInt(perIpRaw, 10) : 0;
    if (perIpCount >= PER_IP_DAILY_LIMIT) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: "LIMIT_REACHED", message: "本日の利用上限に達しました。また明日お試しください。" }),
      };
    }

    // --- サイト全体の1日の上限チェック(サーバー側で必ず判定) ---
    const totalKey = `count:${dateKey}:total`;
    const totalRaw = await usageStore.get(totalKey);
    const totalCount = totalRaw ? parseInt(totalRaw, 10) : 0;
    if (totalCount >= SITE_DAILY_LIMIT) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          error: "LIMIT_REACHED",
          message: "本日はサイト全体の利用上限に達しました。また明日お試しください。",
        }),
      };
    }

    // --- 上限内なので、カウントを先に加算してから生成する ---
    await usageStore.set(perIpKey, String(perIpCount + 1));
    await usageStore.set(totalKey, String(totalCount + 1));

    // --- 曲調プロンプトの生成(必要なら自動短縮) ---
    const raw = await callClaude(buildPrompt(answers));
    const s = parseLabeledSections(raw, ["STYLE_PROMPT", "LYRIC_PROMPT"]);
    if (!s.STYLE_PROMPT || !s.LYRIC_PROMPT) throw new Error("incomplete result");

    const vocalSpec = buildVocalSpecText(answers);
    const vocalClause = vocalSpec ? ` Vocals: ${vocalSpec}.` : "";
    const vocalClauseLen = countChars(vocalClause);
    const aiPartLimit = Math.max(STYLE_PROMPT_HARD_LIMIT - vocalClauseLen, 200);

    let stylePrompt = s.STYLE_PROMPT.trim();
    const styleFieldsText = buildStyleFieldsText(answers);
    let shortenAttempts = 0;
    while (countChars(stylePrompt) > aiPartLimit && shortenAttempts < 2) {
      shortenAttempts++;
      try {
        const shortenRaw = await callClaude(buildShortenStylePrompt(stylePrompt, styleFieldsText, aiPartLimit));
        const s2 = parseLabeledSections(shortenRaw, ["STYLE_PROMPT"]);
        if (s2.STYLE_PROMPT) stylePrompt = s2.STYLE_PROMPT.trim();
      } catch (e) {
        break;
      }
    }
    if (countChars(stylePrompt) > aiPartLimit) {
      stylePrompt = smartTrimToLimit(stylePrompt, aiPartLimit);
    }
    const finalStylePrompt = `${stylePrompt}${vocalClause}`.trim();

    return {
      statusCode: 200,
      body: JSON.stringify({ style: finalStylePrompt, lyric: s.LYRIC_PROMPT }),
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: "GENERATION_FAILED", message: "生成に失敗しました。もう一度お試しください。" }) };
  }
};
