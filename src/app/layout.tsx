import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cursor 安装包镜像 · cursor.sxwzxc.cn",
  description:
    "Cursor 编辑器最新版安装包镜像站，从 cursor.com 官方源同步并缓存于 EdgeOne Pages Blob 存储，适用于无法访问 cursor.com 的网络环境。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark">
      <head>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%231c66e5'/%3E%3Ctext x='12' y='17' font-family='Arial,sans-serif' font-size='14' font-weight='bold' fill='white' text-anchor='middle'%3EC%3C/text%3E%3C/svg%3E"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
