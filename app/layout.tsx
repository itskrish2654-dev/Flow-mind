import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://crazyloops.com"),
  title: {
    default: "CrazyLoops — Run the work. Not every task.",
    template: "%s | CrazyLoops",
  },
  description: "Tell CrazyLoops what should happen. It turns the outcome into a reliable workflow and keeps the work moving.",
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
    title: "CrazyLoops — Run the work. Not every task.",
    description: "Tell CrazyLoops what should happen. It turns the outcome into a reliable workflow and keeps the work moving.",
  },
  twitter: {
    card: "summary_large_image",
    title: "CrazyLoops — Run the work. Not every task.",
    description: "Tell CrazyLoops what should happen. It turns the outcome into a reliable workflow and keeps the work moving.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-[#f4f7fb]">{children}</body>
    </html>
  );
}
