import express from "express";
import Database from "better-sqlite3";

const app = express();
app.use(express.json());

// ────────────────────────────────────────
// DB 初期化
// ────────────────────────────────────────
const db = new Database("sushi.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT    NOT NULL,
    likes   INTEGER NOT NULL DEFAULT 0,
    views   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS comments (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    text    TEXT    NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );
`);

// テーブルが空のときだけ初期データを入れる
const postCount = (db.prepare("SELECT COUNT(*) as cnt FROM posts").get() as { cnt: number }).cnt;
if (postCount === 0) {
  const insertPost = db.prepare("INSERT INTO posts (content, likes, views) VALUES (?, ?, ?)");
  const insertComment = db.prepare("INSERT INTO comments (post_id, text) VALUES (?, ?)");

  const p1 = insertPost.run("エレンの決断は正しかったのか？", 342, 490);
  const p2 = insertPost.run("鬼滅の刃3期の作画がやばい", 187, 467);
  const p3 = insertPost.run("ルフィのギア5、原作とアニメどっちが好き？", 45, 300);

  insertComment.run(p1.lastInsertRowid, "この考察最高すぎる");
  insertComment.run(p1.lastInsertRowid, "アニメ見直した");
  insertComment.run(p2.lastInsertRowid, "ufotableは毎回やばい");
  insertComment.run(p3.lastInsertRowid, "アニメのギア5は笑いすぎた");
}

// ────────────────────────────────────────
// tier 計算
// ────────────────────────────────────────
function calcTier(likes: number, views: number): string {
  const rate = likes / views;
  if (rate >= 0.7) return "gold";
  if (rate >= 0.4) return "silver";
  return "normal";
}

// ────────────────────────────────────────
// エンドポイント
// ────────────────────────────────────────
type Post = { id: number; content: string; likes: number; views: number };
type Comment = { id: number; post_id: number; text: string };

// 投稿一覧
app.get("/posts", (_req, res) => {
  const posts = db.prepare("SELECT * FROM posts").all() as Post[];
  const result = posts.map((p) => ({
    id: p.id,
    content: p.content,
    likes: p.likes,
    views: p.views,
    tier: calcTier(p.likes, p.views),
  }));
  res.json(result);
});

// いいね
app.post("/posts/:id/like", (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }

  db.prepare("UPDATE posts SET likes = likes + 1 WHERE id = ?").run(id);
  const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post;
  res.json({ id: updated.id, likes: updated.likes, tier: calcTier(updated.likes, updated.views) });
});

// コメント一覧
app.get("/posts/:id/comments", (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }

  const comments = db.prepare("SELECT * FROM comments WHERE post_id = ?").all(id) as Comment[];
  res.json(comments.map((c) => ({ id: c.id, text: c.text })));
});

// ────────────────────────────────────────
// サーバー起動
// ────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
