import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { ApolloClientProvider } from '@/components/providers/ApolloProvider';
import { AuthProvider }         from '@/components/providers/AuthProvider';

// One family for the whole product, served with the site rather than fetched
// from Google at runtime: identical on every machine and no flash of a
// fallback. Nothing previously defined the font variable tailwind.config.ts
// referred to, so the app rendered in the Windows system font.
const sans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title:       'AskAITutor — AI-Powered Lecture Assistant',
  description: 'Learn smarter. Ask questions about any lecture via text or voice and get instant AI answers scoped to that lecture only.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
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
