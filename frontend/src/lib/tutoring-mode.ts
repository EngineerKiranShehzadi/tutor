export const TUTORING_MODES = [
 {id:'SIMPLE',label:'Simple',help:'Plain English, short steps'},
 {id:'ACADEMIC',label:'Academic',help:'Precise university-level definitions'},
 {id:'REAL_LIFE_EXAMPLE',label:'Example',help:'Source-grounded example or labelled analogy'},
 {id:'EXAM_PREP',label:'Exam prep',help:'Key points and a self-check'},
 {id:'SOCRATIC',label:'Socratic (beta)',help:'One guided question at a time'},
] as const;
export type TutoringMode = typeof TUTORING_MODES[number]['id'];
