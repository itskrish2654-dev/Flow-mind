import { ImageResponse } from "next/og";

export const alt = "CrazyLoops — Automate work by describing it";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#f7f6f1",
        color: "#181713",
        padding: "76px 84px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", fontSize: 30, fontWeight: 700, letterSpacing: "-1.5px" }}>
        CrazyLoops
        <div style={{ width: 46, height: 7, borderRadius: 99, background: "#f4d63f", marginLeft: 18 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ maxWidth: 900, fontSize: 78, fontWeight: 600, letterSpacing: "-4.8px", lineHeight: 1.01 }}>
          Automate work by describing it.
        </div>
        <div style={{ display: "flex", marginTop: 34, color: "#68675f", fontSize: 25 }}>
          Reliable workflows across AI, forms, webhooks, documents, and data.
        </div>
      </div>
    </div>,
    size,
  );
}
