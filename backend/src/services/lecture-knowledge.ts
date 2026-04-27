// ── Lecture knowledge base — Step 2 data source ─────────────────────────────
// Each lecture has its own named Agent with a dedicated system prompt.
// To expand with real transcripts or a DB: replace/extend the knowledge entries.
// Pipeline (Steps 1 & 3) and agent routing require zero changes.

export interface LectureAgent {
  name:         string; // shown in UI (e.g., "Clarity")
  systemPrompt: string; // full Step 3 system prompt for this agent
}

export interface LectureKnowledge {
  id:         string;
  num:        number;
  title:      string;
  duration:   string;
  topics:     string[];
  concepts:   Record<string, string>; // term → explanation
  keyTerms:   string[];               // fast-match tokens
  agent:      LectureAgent;
}

export const LECTURE_KNOWLEDGE: LectureKnowledge[] = [
  {
    id: 'pCNit2x2gjY',
    num: 0,
    title: 'Introductory Lecture — Introduction to Course, Instructor & ChatGPT-4',
    duration: '34:53',
    topics: ['course overview', 'chatgpt-4', 'instructor introduction', 'ai basics', 'large language models', 'generative ai introduction'],
    concepts: {
      'ChatGPT-4': 'The fourth generation of OpenAI\'s chat-based AI, capable of understanding and generating complex text with high accuracy.',
      'large language model (LLM)': 'A machine learning model trained on vast amounts of text data to understand and generate human language.',
      'AI': 'Artificial Intelligence — systems designed to perform tasks that typically require human intelligence, such as understanding language and generating text.',
      'course overview': 'This course covers prompt engineering fundamentals, taught by Dr. Adeel Nawab (PhD UK) at FQKII, focusing on practical skills for effective AI interaction.',
      'tokens': 'The smallest units of text that an LLM processes — roughly 3/4 of a word on average. Models have a token limit per request.',
    },
    keyTerms: ['chatgpt', 'gpt-4', 'gpt4', 'ai', 'llm', 'course', 'introduction', 'intro', 'dr nawab', 'overview', 'generative'],
    agent: {
      name: 'Nova',
      systemPrompt:
        'You are Nova, an AI tutor for the introductory lecture of this Prompt Engineering course. ' +
        'You help students get oriented — what the course covers, who teaches it, and what ChatGPT-4 is. ' +
        'STRICT RULES: Use ONLY the facts in ACTUAL DATA below. Never invent. ' +
        'Write 2-3 sentences. Warm, welcoming tone. Use <strong> tags on 1-2 key terms.',
    },
  },
  {
    id: '0YM7Cfp8dIQ',
    num: 1,
    title: 'Lecture 1 — Introduction to Generative AI & Prompt Engineering',
    duration: '44:43',
    topics: ['generative ai', 'prompt engineering', 'what is a prompt', 'ai text generation', 'llm fundamentals', 'natural language processing'],
    concepts: {
      'generative AI': 'AI systems that can generate new content — text, images, code — based on patterns learned from training data.',
      'prompt engineering': 'The practice of designing and refining input prompts to reliably guide AI models toward desired, accurate outputs.',
      'prompt': 'The input text or instruction given to an AI model. The quality of the prompt directly determines the quality of the AI\'s response.',
      'inference': 'The process by which a trained AI model generates output from a given input prompt at runtime.',
      'natural language processing (NLP)': 'A field of AI focused on enabling computers to understand, interpret, and generate human language.',
      'training data': 'The large corpus of text an LLM learns from. The model\'s knowledge is limited to patterns in this data.',
    },
    keyTerms: ['generative', 'prompt', 'engineering', 'intro', 'fundamentals', 'llm', 'text generation', 'nlp', 'what is'],
    agent: {
      name: 'Sage',
      systemPrompt:
        'You are Sage, a generative AI fundamentals tutor for Lecture 1. ' +
        'Your focus is explaining what generative AI is, what a prompt is, and why prompt engineering matters. ' +
        'STRICT RULES: Use ONLY the facts in ACTUAL DATA below. Never invent. ' +
        'Write 2-3 sentences. Clear, foundational tone. Use <strong> tags on 1-2 key terms.',
    },
  },
  {
    id: '1mi-gFalmSQ',
    num: 2,
    title: 'Lecture 2 — Fundamentals of Crafting Simple, Fast & Accurate Prompts',
    duration: '33:26',
    topics: ['simple prompts', 'fast prompts', 'accurate prompts', 'zero-shot', 'few-shot', 'clarity', 'specificity', 'prompt length', 'output format'],
    concepts: {
      'zero-shot prompt': 'A prompt that gives the AI a task without any examples. Works best for well-defined, simple tasks the model already understands.',
      'few-shot prompt': 'A prompt that includes a small number of examples (2–5) to demonstrate the desired output format or reasoning style.',
      'clarity': 'Using clear, unambiguous language in prompts — avoiding vague terms that could confuse the model into multiple interpretations.',
      'specificity': 'Being explicit about what you want: format, length, tone, and constraints. Instead of "list ideas", say "list 5 ideas in bullet points".',
      'prompt length': 'Prompt length matters — too short produces vague results, too long can dilute the key instruction. One clear instruction with just enough context is ideal.',
      'fast prompt': 'A prompt that avoids redundant context the model already knows from training, keeping instructions lean and direct.',
      'accurate prompt': 'A prompt designed to maximize factual correctness by providing context, adding output constraints, and specifying the expected format.',
      'output format': 'Explicitly stating how the AI should format its response — bullet points, numbered list, JSON, table, or prose.',
    },
    keyTerms: ['zero-shot', 'zeroshot', 'few-shot', 'fewshot', 'simple', 'fast', 'accurate', 'clarity', 'specific', 'prompt length', 'crafting', 'format', 'output'],
    agent: {
      name: 'Clarity',
      systemPrompt:
        'You are Clarity, a prompt crafting coach for Lecture 2. ' +
        'You specialise in zero-shot prompts, few-shot prompts, and the art of writing simple, fast, and accurate instructions. ' +
        'STRICT RULES: Use ONLY the facts in ACTUAL DATA below. Never invent. ' +
        'Write 2-3 sentences. Practical, encouraging tone. Use <strong> tags on 1-2 key terms.',
    },
  },
  {
    id: 'CIkEryaQ7ok',
    num: 3,
    title: 'Lecture 3 — Prompt Formulation Process',
    duration: '26:48',
    topics: ['prompt formulation', 'structured prompts', 'step-by-step prompting', 'chain-of-thought', 'prompt design process', 'role prompting', 'context setting'],
    concepts: {
      'prompt formulation process': 'A systematic approach: 1) Define the task, 2) Assign a role, 3) Add relevant context, 4) Set output constraints, 5) Test and refine.',
      'chain-of-thought prompting': 'Asking the AI to reason step-by-step before giving the final answer. Significantly improves accuracy on complex or multi-step problems.',
      'role prompting': 'Assigning a persona or expert role ("Act as a senior software engineer") to prime the AI for domain-specific, higher-quality responses.',
      'structured prompt': 'A prompt organized into clear sections: Role → Task → Context → Format → Constraints. Reduces ambiguity.',
      'context setting': 'Providing the AI with background information so it can generate more relevant and accurate responses.',
      'instruction following': 'How well an AI model adheres to explicit instructions in the prompt. Clearer instructions lead to better instruction following.',
    },
    keyTerms: ['formulation', 'process', 'chain of thought', 'chain-of-thought', 'cot', 'step by step', 'role', 'structured', 'design', 'context', 'instruction'],
    agent: {
      name: 'Craft',
      systemPrompt:
        'You are Craft, a prompt formulation process expert for Lecture 3. ' +
        'You guide students through the systematic steps of designing effective prompts: role, task, context, format, constraints — including chain-of-thought techniques. ' +
        'STRICT RULES: Use ONLY the facts in ACTUAL DATA below. Never invent. ' +
        'Write 2-3 sentences. Methodical, precise tone. Use <strong> tags on 1-2 key terms.',
    },
  },
  {
    id: 'IQNZNTdZhZg',
    num: 4,
    title: 'Lecture 4 — Prompt Engineering Techniques for Text Generation',
    duration: '31:08',
    topics: ['text generation', 'prompt techniques', 'temperature', 'creative prompts', 'style prompts', 'tone control', 'output formatting', 'top-p sampling'],
    concepts: {
      'temperature': 'A model parameter (0.0–1.0+) controlling output randomness. Low values (0.1–0.3) = factual, deterministic. High values (0.8–1.0) = creative, varied.',
      'top-p (nucleus) sampling': 'A technique limiting the AI to consider only the most probable tokens summing to probability p, balancing quality and diversity.',
      'tone control': 'Using prompt instructions to control writing style — formal, casual, technical, friendly, persuasive — by explicitly naming the tone.',
      'output formatting': 'Specifying in the prompt how results should be structured: bullet lists, numbered steps, tables, JSON, markdown, or plain prose.',
      'creative prompts': 'Prompts designed for imaginative output like stories, poems, or brainstorming. Use higher temperature and open-ended framing.',
      'style transfer': 'Prompting the AI to rewrite content in a different style — e.g., "rewrite this formally" or "explain this like I\'m 10".',
      'constrained generation': 'Using prompt rules to limit what the AI says — word count, forbidden topics, required elements.',
    },
    keyTerms: ['text generation', 'temperature', 'creative', 'style', 'tone', 'format', 'output', 'techniques', 'top-p', 'sampling', 'constrained'],
    agent: {
      name: 'Prism',
      systemPrompt:
        'You are Prism, a text generation techniques specialist for Lecture 4. ' +
        'You help students understand temperature, tone control, output formatting, top-p sampling, and creative vs constrained generation. ' +
        'STRICT RULES: Use ONLY the facts in ACTUAL DATA below. Never invent. ' +
        'Write 2-3 sentences. Energetic, creative-but-focused tone. Use <strong> tags on 1-2 key terms.',
    },
  },
  {
    id: 'Hv8judoCF0g',
    num: 5,
    title: 'Lecture 5 — Prompt Engineering for Question Answering (QA)',
    duration: '1:04:29',
    topics: ['question answering', 'qa prompts', 'information extraction', 'retrieval', 'factual prompts', 'rag basics', 'grounding', 'hallucination prevention'],
    concepts: {
      'question answering (QA)': 'Designing prompts that reliably extract specific answers from given text or generate factually correct responses to direct questions.',
      'grounding': 'Providing the AI with actual data or documents in the prompt so it answers from that data, not from training memory.',
      'retrieval-augmented generation (RAG)': 'A technique combining retrieval (finding relevant documents) with generation (AI answers using only those documents). Reduces hallucination.',
      'information extraction': 'Using prompts to pull out specific facts, entities, dates, or data points from a body of text.',
      'hallucination': 'When an AI generates confident-sounding but factually incorrect information not present in training data or context.',
      'closed-book vs open-book QA': 'Closed-book: AI answers from training memory only. Open-book: AI is given documents and must answer from them (more accurate).',
      'factual grounding rule': 'The key rule: always tell the AI "use ONLY the data below" and "if a fact is not in the data, do not mention it". This prevents hallucination.',
    },
    keyTerms: ['qa', 'question answering', 'rag', 'retrieval', 'extraction', 'factual', 'grounding', 'hallucination', 'open-book', 'closed-book', 'document'],
    agent: {
      name: 'Oracle',
      systemPrompt:
        'You are Oracle, a question-answering and RAG specialist for Lecture 5. ' +
        'You explain grounding, retrieval-augmented generation, hallucination prevention, and information extraction techniques. ' +
        'STRICT RULES: Use ONLY the facts in ACTUAL DATA below. Never invent. ' +
        'Write 2-3 sentences. Precise, factual tone. Use <strong> tags on 1-2 key terms.',
    },
  },
  {
    id: 'jGsf0ppO3Js',
    num: 6,
    title: 'Lecture 6 — Evaluation, Ethics & Future of Prompt Engineering',
    duration: '35:44',
    topics: ['evaluation', 'ethics', 'future ai', 'bias', 'fairness', 'responsible ai', 'prompt injection', 'ai safety', 'evaluation metrics'],
    concepts: {
      'prompt injection': 'A security vulnerability where malicious text in user input hijacks the AI\'s behavior by overriding original system instructions.',
      'bias in AI': 'Systematic errors in AI output reflecting prejudices from training data — affects fairness, accuracy, and inclusivity of responses.',
      'evaluation metrics': 'Methods for measuring prompt quality: accuracy, coherence, helpfulness, consistency, safety, and relevance.',
      'responsible AI': 'Using AI ethically: avoiding harm, ensuring fairness, being transparent about AI use, respecting privacy, and verifying facts.',
      'future of prompt engineering': 'As models improve, prompting evolves toward more conversational, tool-augmented, and agentic forms — but grounding and clarity remain essential.',
      'prompt jailbreaking': 'Attempts to bypass safety filters through clever prompt construction. Ethical prompt engineers design against this.',
      'AI alignment': 'Ensuring AI systems behave in accordance with human values and intentions — a core challenge as models become more powerful.',
    },
    keyTerms: ['ethics', 'evaluation', 'future', 'bias', 'fairness', 'responsible', 'injection', 'safety', 'metrics', 'alignment', 'jailbreak'],
    agent: {
      name: 'Virtue',
      systemPrompt:
        'You are Virtue, an AI ethics and futures advisor for Lecture 6. ' +
        'You help students understand responsible AI, bias, evaluation metrics, prompt injection risks, and the trajectory of prompt engineering. ' +
        'STRICT RULES: Use ONLY the facts in ACTUAL DATA below. Never invent. ' +
        'Write 2-3 sentences. Thoughtful, considered tone. Use <strong> tags on 1-2 key terms.',
    },
  },
];
