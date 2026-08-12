import Link from "next/link";

export function TrustLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal and support" className={className}>
      <Link href="/privacy">Privacy</Link>
      <Link href="/terms">Terms</Link>
      <Link href="/security">Security</Link>
      <Link href="/data-use">Data use</Link>
      <Link href="/support">Support</Link>
    </nav>
  );
}
