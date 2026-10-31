import { GraphQLError, Kind, type FragmentDefinitionNode, type SelectionSetNode, type ValidationRule } from 'graphql';

// Rejects operations that are too deep or select too many fields, before
// anything executes — a cheap guard against a query built to be expensive
// (deep nesting, or the same field aliased hundreds of times). Fragments are
// expanded where they are used, so they cannot hide depth or size.
// Introspection meta-fields (__typename, __schema, __type) are not counted;
// introspection itself is switched off in production (graphql/index.ts).
//
// The app's own deepest query is 3 levels and its largest selects 22 fields;
// test-admin-hardening checks every frontend operation against these limits.

export interface QueryLimits { maxDepth: number; maxFields: number }

export function queryLimitsRule({ maxDepth, maxFields }: QueryLimits): ValidationRule {
  return context => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const d of context.getDocument().definitions) {
      if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
    }

    return {
      OperationDefinition(op) {
        let fields = 0;
        let deepest = 0;
        let stop = false;
        const walk = (set: SelectionSetNode, depth: number, path: Set<string>): void => {
          for (const sel of set.selections) {
            if (stop) return;
            if (sel.kind === Kind.FIELD) {
              if (sel.name.value.startsWith('__')) continue;
              fields++;
              deepest = Math.max(deepest, depth + 1);
              if (deepest > maxDepth || fields > maxFields) { stop = true; return; }
              if (sel.selectionSet) walk(sel.selectionSet, depth + 1, path);
            } else if (sel.kind === Kind.INLINE_FRAGMENT) {
              walk(sel.selectionSet, depth, path);
            } else {
              const name = sel.name.value;
              const frag = fragments.get(name);
              // A fragment cycle is rejected by graphql's own NoFragmentCycles rule.
              if (frag && !path.has(name)) walk(frag.selectionSet, depth, new Set([...path, name]));
            }
          }
        };
        walk(op.selectionSet, 0, new Set());
        if (deepest > maxDepth) {
          context.reportError(new GraphQLError(`Query is too deep: more than ${maxDepth} levels.`, {
            nodes: [op], extensions: { code: 'QUERY_TOO_DEEP' },
          }));
        } else if (fields > maxFields) {
          context.reportError(new GraphQLError(`Query selects too many fields: more than ${maxFields}.`, {
            nodes: [op], extensions: { code: 'QUERY_TOO_LARGE' },
          }));
        }
      },
    };
  };
}
