'use client';
import { useEffect, useMemo, useRef } from 'react';
import { ApolloProvider } from '@apollo/client';
import type { DocumentNode } from 'graphql';
import { useRouter } from 'next/navigation';
import { apolloClient } from '@/lib/apollo-client';
import { createStudentApolloClient } from '@/lib/student-apollo';
import { GET_COURSES } from '@/graphql/course.queries';
import { GET_LECTURES, GET_LECTURE } from '@/graphql/lecture.queries';
import { GET_PRACTICE_HISTORY, GET_PRACTICE_PROGRESS } from '@/graphql/practice.queries';
import { MY_STATS_QUERY, MY_RECENT_QUESTIONS_QUERY } from '@/graphql/analytics.queries';
import { createPrefetchGate, studentDestination } from '@/lib/student-prefetch';

// Mounted only inside the authenticated STUDENT layout, keyed by account ID.
// The transport is shared; cache and in-flight query manager are not.
export function StudentNavigationProvider({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => createStudentApolloClient(apolloClient.link), []);
  const disposal = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(disposal.current);
    // Strict Mode remounts effects immediately; real unmount retires this client.
    return () => { disposal.current = setTimeout(() => client.stop(), 0); };
  }, [client]);
  const router = useRouter();
  useEffect(() => {
    const gate = createPrefetchGate();
    let disposed = false;
    const read = (key: string, query: DocumentNode, variables?: Record<string, unknown>) =>
      gate.run(key, () => disposed ? Promise.resolve() : client.query({ query, variables, fetchPolicy: 'network-only' }));
    const catalog = () => Promise.all([read('courses', GET_COURSES), read('lectures', GET_LECTURES)]);
    const prefetch = (href: string) => {
      const target = studentDestination(href, window.location.origin);
      if (!target || disposed || !navigator.onLine) return;
      void gate.run(`route:${href}`, async () => { router.prefetch(href); });
      if (['/courses', '/lectures', '/practice'].includes(target.path)) void catalog();
      if (target.lectureId) void read(`lecture:${target.lectureId}`, GET_LECTURE, { id: target.lectureId });
      if (target.path === '/practice') void read('quiz-history', GET_PRACTICE_HISTORY);
      if (target.path === '/profile/activity') {
        void read('my-stats', MY_STATS_QUERY);
        void read('my-recent', MY_RECENT_QUESTIONS_QUERY, { limit: 1, offset: 0 });
        void read('quiz-progress', GET_PRACTICE_PROGRESS);
      }
    };
    // Metadata only, after authentication. Never generate quizzes or chat sessions.
    void catalog();
    const intent = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest('a[href]');
      if (link) prefetch(link.getAttribute('href')!);
    };
    const refresh = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void catalog();
      prefetch(window.location.pathname + window.location.search);
    };
    document.addEventListener('pointerover', intent, { passive: true });
    document.addEventListener('focusin', intent);
    document.addEventListener('touchstart', intent, { passive: true });
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true; gate.clear();
      document.removeEventListener('pointerover', intent);
      document.removeEventListener('focusin', intent);
      document.removeEventListener('touchstart', intent);
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [client, router]);
  return <ApolloProvider client={client}>{children}</ApolloProvider>;
}
