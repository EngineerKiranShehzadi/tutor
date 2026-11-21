// Public surface of the agentic RAG graph module.
//
// Safe (control-flow) exports — no real-service imports, usable in tests:
export { buildAgenticGraph, runAgenticGraph } from './graph';
export type { AgenticGraph, AgenticInput, BuildOptions } from './graph';
export { AgenticState } from './state';
export type { AgenticStateType, NodeUpdate, RetrievalGrade } from './state';
export { DEFAULT_GRAPH_CONFIG } from './deps';
export type { GraphDeps, GraphConfig, GenerateArgs, ReviseArgs, GroundednessResult } from './deps';

// Production surface — pulls in real services (full backend only):
export { buildProductionDeps } from './production-deps';
export type { ProductionDepsContext } from './production-deps';
export { askLectureAgentViaGraph } from './entry';
export type { AskViaGraphInput, AskViaGraphResult } from './entry';
