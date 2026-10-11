import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://www.crazy-loops.com"),
  title: {
    default: "CrazyLoops — From company goals to completed work. With AI.",
    template: "%s | CrazyLoops",
  },
  description: "Managers coordinate work, employees produce reviewed results with AI, and teams make repeated work repeatable.",
  applicationName: "CrazyLoops",
  authors: [{ name: "CrazyLoops" }],
  creator: "CrazyLoops",
  publisher: "CrazyLoops",
  category: "technology",
  alternates: { canonical: "https://www.crazy-loops.com/" },
  openGraph: {
    type: "website",
    siteName: "CrazyLoops",
    url: "https://www.crazy-loops.com/",
    title: "CrazyLoops — From company goals to completed work. With AI.",
    description: "Managers coordinate work, employees produce reviewed results with AI, and teams make repeated work repeatable.",
  },
  twitter: {
    card: "summary_large_image",
    title: "CrazyLoops — From company goals to completed work. With AI.",
    description: "Managers coordinate work, employees produce reviewed results with AI, and teams make repeated work repeatable.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-[#f4f7fb]">{children}</body>
    </html>
  );
}
