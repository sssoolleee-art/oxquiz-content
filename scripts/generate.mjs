// OX퀴즈 문제 자동 생성 파이프라인
// Claude API로 새 문제 배치를 생성 → 스키마/중복 검증 → 자기 검수(fact-check) → questions.json에 누적.
// 실행: ANTHROPIC_API_KEY=... node scripts/generate.mjs [개수(기본 25)]
import { readFileSync, writeFileSync } from 'node:fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ANTHROPIC_API_KEY 필요'); process.exit(1); }

const COUNT = Number(process.argv[2] ?? 25);
const MODEL = 'claude-sonnet-4-6';
const CATEGORIES = ['common', 'science', 'history', 'korean', 'food', 'sports', 'culture'];

const pool = JSON.parse(readFileSync('questions.json', 'utf8'));
const bundled = JSON.parse(readFileSync('existing-statements.json', 'utf8'));
const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();
const known = new Set([...bundled, ...pool.map((q) => q.statement)].map(normalize));

async function callClaude(system, user, maxTokens = 8000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.map((b) => b.text ?? '').join('');
}

function extractJson(text) {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('JSON 배열을 찾지 못함');
  return JSON.parse(m[0]);
}

// 모델이 answer를 "O"/"X" 문자열로 주는 경우 불리언으로 강제 변환
function coerce(q) {
  if (q && typeof q.answer === 'string') {
    const a = q.answer.trim().toUpperCase();
    if (a === 'O' || a === 'TRUE') q.answer = true;
    else if (a === 'X' || a === 'FALSE') q.answer = false;
  }
  return q;
}

function validate(q) {
  return (
    typeof q.statement === 'string' && q.statement.length >= 8 && q.statement.length <= 80 &&
    typeof q.answer === 'boolean' &&
    typeof q.explanation === 'string' && q.explanation.length >= 20 &&
    CATEGORIES.includes(q.category) &&
    ['easy', 'normal', 'hard'].includes(q.difficulty) &&
    !known.has(normalize(q.statement))
  );
}

const GEN_SYSTEM = `당신은 한국어 OX 상식 퀴즈 출제 전문가입니다. 40~60대 한국인이 재미있어할, 사실에 근거한 OX 문제를 만듭니다.
규칙:
- statement는 단정문 (O 또는 X로 판별 가능), 8~80자
- 정답이 O인 문제와 X인 문제를 절반씩 섞기
- "의외의 사실"(정답률이 낮을 만한 것)을 우선하되, 반드시 검증 가능한 사실만
- explanation은 존댓말 "~예요/~돼요" 톤, 근거를 한 문장 이상 포함
- 논란·시사·정치·의학적 조언은 금지, 시간이 지나면 틀려지는 사실(최신 기록 등) 금지
- category: common|science|history|korean|food|sports|culture 고루 분배
- difficulty: normal 위주, 5문제 중 1개꼴로 hard (보너스용 고난도)`;

async function main() {
  console.log(`${COUNT}문제 생성 요청 (모델: ${MODEL})`);
  const genText = await callClaude(
    GEN_SYSTEM,
    `새 OX 퀴즈 ${COUNT + 10}문제를 JSON 배열로만 출력하세요. 각 원소: {"statement","answer","explanation","category","difficulty"}. answer는 반드시 JSON boolean (참이면 true, 거짓이면 false).
다음 기존 문제들과 겹치지 않게: ${JSON.stringify([...known].slice(-150))}`,
  );
  const raw = extractJson(genText);
  console.log(`파싱 ${raw.length}개, 샘플:`, JSON.stringify(raw[0]).slice(0, 200));
  const candidates = raw.map(coerce).filter(validate);
  console.log(`1차 생성 ${candidates.length}개 (검증 통과)`);
  if (candidates.length === 0 && raw.length > 0) {
    const q = raw[0];
    console.log('디버그:', {
      stmt: typeof q.statement === 'string' && q.statement.length >= 8 && q.statement.length <= 80,
      ans: typeof q.answer === 'boolean',
      expl: typeof q.explanation === 'string' && q.explanation.length >= 20,
      cat: CATEGORIES.includes(q.category),
      diff: ['easy', 'normal', 'hard'].includes(q.difficulty),
      dup: known.has(normalize(q.statement)),
    });
  }

  // 자기 검수: 사실관계가 불확실한 문제 제거
  const checkText = await callClaude(
    '당신은 사실 검증 전문가입니다. 각 OX 퀴즈의 statement와 answer가 사실과 일치하는지 엄격히 검증합니다.',
    `다음 퀴즈 배열에서 (1) 사실이 아니거나 (2) 논란의 여지가 있거나 (3) answer가 틀린 항목의 인덱스만 JSON 배열로 출력하세요. 전부 정확하면 []를 출력하세요.\n${JSON.stringify(candidates.map((q, i) => ({ i, statement: q.statement, answer: q.answer })))}`,
    2000,
  );
  const rejected = new Set(extractJson(checkText));
  const passed = candidates.filter((_, i) => !rejected.has(i)).slice(0, COUNT);
  console.log(`검수 탈락 ${rejected.size}개 → 최종 ${passed.length}개`);

  let nextId = pool.length + 1;
  const stamped = passed.map((q) => ({
    id: `r${String(nextId++).padStart(4, '0')}`,
    statement: q.statement,
    answer: q.answer,
    correctRate: Math.round((0.25 + Math.random() * 0.5) * 100) / 100,
    explanation: q.explanation,
    category: q.category,
    difficulty: q.difficulty,
  }));

  writeFileSync('questions.json', JSON.stringify([...pool, ...stamped], null, 2) + '\n');
  console.log(`questions.json 누적 ${pool.length + stamped.length}문제`);
}

main().catch((e) => { console.error(e); process.exit(1); });
