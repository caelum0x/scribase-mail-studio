import "./globals.css";

import { Inter } from "next/font/google";
import { JetBrains_Mono } from "next/font/google";
import type { Metadata } from "next";
import { ThemeProvider } from "@usesend/ui";
import Script from "next/script";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const TITLE = "Scribase Mail - Email API and dashboard";
const DESCRIPTION =
  "Send transactional and marketing email with a familiar REST API and a calm dashboard. Part of Scribase.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  icons: [{ rel: "icon", url: "/favicon.ico" }],
  metadataBase: new URL("https://mail.scribase.com"),
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://mail.scribase.com",
    siteName: "Scribase Mail",
    images: [
      {
        url: "/logo-squircle.png",
        width: 650,
        height: 650,
        alt: "Scribase Mail",
        type: "image/png",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/logo-squircle.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: "https://mail.scribase.com",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="scroll-smooth bg-background"
    >
      {process.env.NODE_ENV === "production" && (
        <Script src="https://scripts.simpleanalyticscdn.com/latest.js" />
      )}
      <body
        className={`font-mono ${inter.variable} ${jetbrainsMono.variable} bg-background`}
      >
        {/* System theme with isolated storage to avoid stale overrides */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="marketing-theme"
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
