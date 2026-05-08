import type { Metadata } from 'next';
import './globals.css';
import { ApolloClientProvider } from '@/components/providers/ApolloProvider';
import { AuthProvider }         from '@/components/providers/AuthProvider';

export const metadata: Metadata = {
  title:       'AskAITutor — AI-Powered Lecture Assistant',
  description: 'Learn smarter. Ask questions about any lecture via text or voice and get instant AI answers scoped to that lecture only.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
        />
      </head>
      <body><ApolloClientProvider><AuthProvider>{children}</AuthProvider></ApolloClientProvider></body>
    </html>
  );
}
