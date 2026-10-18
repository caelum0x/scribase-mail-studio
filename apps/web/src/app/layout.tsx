import "./globals.css";

import { Inter } from "next/font/google";
import { JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@usesend/ui";
import { Toaster } from "@usesend/ui/src/toaster";
import Script from "next/script";

import { TRPCReactProvider } from "~/trpc/react";
import { Metadata } from "next";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Scribase Mail",
  description: "Open source email platform",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className="bg-sidebar-background">
      <body
        className={`font-sans ${inter.variable} ${jetbrainsMono.variable} app bg-sidebar-background`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Toaster />
          <TRPCReactProvider>{children}</TRPCReactProvider>
        </ThemeProvider>
        {/* X conversion tracking base code */}
        <Script id="x-conversion-tracking" strategy="afterInteractive">
          {`
!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments);
},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',
a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');
twq('config','rhhqi');
`}
        </Script>
        {/* End X conversion tracking base code */}
      </body>
    </html>
  );
}
