import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./extra.css";

export async function generateMetadata():Promise<Metadata>{
  const h=await headers();const host=h.get("x-forwarded-host")||h.get("host")||"localhost:3000";const protocol=h.get("x-forwarded-proto")||(host.startsWith("localhost")?"http":"https");const image=`${protocol}://${host}/og.png`;const title="PBI Quality Studio";const description="Power BI model quality, DAX review & collaborative QA";
  return{title,description,icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"},openGraph:{title,description,images:[image]},twitter:{card:"summary_large_image",title,description,images:[image]}};
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Fallback only. Gotham is licensed and cannot be bundled, so the font
            stack in globals.css prefers it and lands on Montserrat when Gotham
            is neither installed nor supplied in public/fonts. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- this is the
            app-router root layout, so the link is global, not per-page. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
