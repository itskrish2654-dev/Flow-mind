import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://crazyloops.com"),
  title: {
    default: "CrazyLoops — Automate work by describing it",
    template: "%s | CrazyLoops",
  },
  description: "Build reliable AI-powered workflows from plain English with forms, webhooks, documents, data, and supported app connections.",
  applicationName: "CrazyLoops",
  authors: [{ name: "CrazyLoops" }],
  creator: "CrazyLoops",
  publisher: "CrazyLoops",
  category: "technology",
  alternates: { canonical: "https://crazyloops.com/" },
  openGraph: {
    type: "website",
    siteName: "CrazyLoops",
    url: "https://crazyloops.com/",
    title: "CrazyLoops — Automate work by describing it",
    description: "Build reliable AI-powered workflows from plain English with forms, webhooks, documents, data, and supported app connections.",
  },
  twitter: {
    card: "summary_large_image",
    title: "CrazyLoops — Automate work by describing it",
    description: "Build reliable AI-powered workflows from plain English with forms, webhooks, documents, data, and supported app connections.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-[#f4f7fb]">{children}</body>
    </html>
  );
}
