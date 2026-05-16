import express from "express";
import cors from "cors";
import { createClient } from "@libsql/client";

const app = express();
app.use(cors());
app.use(express.json());

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_TOKEN!,
});

// ────────────────────────────────────────
// 型定義
// ────────────────────────────────────────
type Post    = { id: number; content: string; likes: number; views: number; user_id: string; room: string; created_at: string; spoiler: number };
type Comment = { id: number; post_id: number; text: string; user_id: string; likes: number; created_at: string };
type Bucket  = { id: number; name: string; user_id: string; created_at: string };
type Reply   = { id: number; comment_id: number; text: string; user_id: string; created_at: string };

// ────────────────────────────────────────
// tier 計算
// ────────────────────────────────────────
function calcTier(likes: number, views: number): string {
  if (views === 0) return "normal";
  const rate = likes / views;
  if (rate >= 0.7) return "gold";
  if (rate >= 0.4) return "silver";
  return "normal";
}

// ────────────────────────────────────────
// DB 初期化
// ────────────────────────────────────────
async function initDb() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS posts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT    NOT NULL,
      likes      INTEGER NOT NULL DEFAULT 0,
      views      INTEGER NOT NULL DEFAULT 0,
      user_id    TEXT    NOT NULL DEFAULT 'system',
      room       TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      spoiler    INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL,
      text       TEXT    NOT NULL,
      user_id    TEXT    NOT NULL DEFAULT 'system',
      likes      INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES posts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS comment_likes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      user_id    TEXT    NOT NULL,
      FOREIGN KEY (comment_id) REFERENCES comments(id)
    )`,
    `CREATE TABLE IF NOT EXISTS post_likes (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id TEXT    NOT NULL,
      FOREIGN KEY (post_id) REFERENCES posts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS buckets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS bucket_posts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_id INTEGER NOT NULL,
      post_id   INTEGER NOT NULL,
      FOREIGN KEY (bucket_id) REFERENCES buckets(id),
      FOREIGN KEY (post_id)   REFERENCES posts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS comment_replies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      text       TEXT    NOT NULL,
      user_id    TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (comment_id) REFERENCES comments(id)
    )`,
  ], "write");

  // テーブルが空のときだけ初期データを入れる
  const { rows: countRows } = await db.execute("SELECT COUNT(*) as cnt FROM posts");
  const cnt = Number(countRows[0].cnt);
  if (cnt === 0) {
    const p1 = await db.execute({ sql: "INSERT INTO posts (content, likes, views, user_id, room) VALUES (?, ?, ?, ?, ?)", args: ["エレンの決断は正しかったのか？", 342, 490, "system", "キャラ考察"] });
    const p2 = await db.execute({ sql: "INSERT INTO posts (content, likes, views, user_id, room) VALUES (?, ?, ?, ?, ?)", args: ["鬼滅の刃3期の作画がやばい", 187, 467, "system", "最新話速報"] });
    const p3 = await db.execute({ sql: "INSERT INTO posts (content, likes, views, user_id, room) VALUES (?, ?, ?, ?, ?)", args: ["ルフィのギア5、原作とアニメどっちが好き？", 45, 300, "system", "キャラ考察"] });

    await db.batch([
      { sql: "INSERT INTO comments (post_id, text, user_id) VALUES (?, ?, ?)", args: [Number(p1.lastInsertRowid), "この考察最高すぎる", "system"] },
      { sql: "INSERT INTO comments (post_id, text, user_id) VALUES (?, ?, ?)", args: [Number(p1.lastInsertRowid), "アニメ見直した", "system"] },
      { sql: "INSERT INTO comments (post_id, text, user_id) VALUES (?, ?, ?)", args: [Number(p2.lastInsertRowid), "ufotableは毎回やばい", "system"] },
      { sql: "INSERT INTO comments (post_id, text, user_id) VALUES (?, ?, ?)", args: [Number(p3.lastInsertRowid), "アニメのギア5は笑いすぎた", "system"] },
    ], "write");
  }
}

// ────────────────────────────────────────
// 投稿エンドポイント
// ────────────────────────────────────────

// ユーザーがいいねした投稿ID一覧
app.get("/posts/liked", async (req, res) => {
  const { user_id } = req.query as { user_id: string };
  if (!user_id) { res.status(400).json({ error: "user_id is required" }); return; }
  const { rows } = await db.execute({ sql: "SELECT post_id FROM post_likes WHERE user_id = ?", args: [user_id] });
  res.json(rows.map((r) => Number(r.post_id)));
});

// 投稿一覧
app.get("/posts", async (_req, res) => {
  const { rows } = await db.execute("SELECT * FROM posts ORDER BY created_at DESC");
  const posts = rows as unknown as Post[];
  res.json(posts.map((p) => ({
    id: p.id, content: p.content, likes: Number(p.likes), views: Number(p.views),
    user_id: p.user_id, room: p.room, created_at: p.created_at,
    spoiler: Number(p.spoiler ?? 0), tier: calcTier(Number(p.likes), Number(p.views)),
  })));
});

// 投稿を作成
app.post("/posts", async (req, res) => {
  const { content, user_id, room, spoiler } = req.body as { content: string; user_id: string; room: string; spoiler?: boolean };
  if (!content || content.trim() === "") { res.status(400).json({ error: "content is required" }); return; }
  if (!user_id) { res.status(400).json({ error: "user_id is required" }); return; }

  const result = await db.execute({ sql: "INSERT INTO posts (content, user_id, room, spoiler) VALUES (?, ?, ?, ?)", args: [content.trim(), user_id, room ?? "", spoiler ? 1 : 0] });
  const { rows } = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [Number(result.lastInsertRowid)] });
  const post = rows[0] as unknown as Post;
  res.status(201).json({ ...post, likes: Number(post.likes), views: Number(post.views), spoiler: Number(post.spoiler), tier: calcTier(Number(post.likes), Number(post.views)) });
});

// 投稿を削除
app.delete("/posts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const { rows } = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [id] });
  const post = rows[0] as unknown as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }
  if (post.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  await db.execute({ sql: "DELETE FROM posts WHERE id = ?", args: [id] });
  res.json({ message: "deleted" });
});

// いいね
app.post("/posts/:id/like", async (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const { rows: postRows } = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [id] });
  if (!postRows[0]) { res.status(404).json({ error: "Post not found" }); return; }

  const { rows: likeRows } = await db.execute({ sql: "SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?", args: [id, user_id] });
  if (likeRows[0]) { res.status(400).json({ error: "Already liked" }); return; }

  await db.batch([
    { sql: "INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", args: [id, user_id] },
    { sql: "UPDATE posts SET likes = likes + 1 WHERE id = ?", args: [id] },
  ], "write");

  const { rows } = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [id] });
  const updated = rows[0] as unknown as Post;
  res.json({ id: updated.id, likes: Number(updated.likes), tier: calcTier(Number(updated.likes), Number(updated.views)) });
});

// いいね取り消し
app.delete("/posts/:id/like", async (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const { rows: postRows } = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [id] });
  if (!postRows[0]) { res.status(404).json({ error: "Post not found" }); return; }

  const { rows: likeRows } = await db.execute({ sql: "SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?", args: [id, user_id] });
  if (!likeRows[0]) { res.status(400).json({ error: "Not liked yet" }); return; }

  await db.batch([
    { sql: "DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", args: [id, user_id] },
    { sql: "UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = ?", args: [id] },
  ], "write");

  const { rows } = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [id] });
  const updated = rows[0] as unknown as Post;
  res.json({ id: updated.id, likes: Number(updated.likes), tier: calcTier(Number(updated.likes), Number(updated.views)) });
});

// ────────────────────────────────────────
// コメントエンドポイント
// ────────────────────────────────────────

// コメント一覧
app.get("/posts/:id/comments", async (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.query as { user_id?: string };

  const { rows: postRows } = await db.execute({ sql: "SELECT 1 FROM posts WHERE id = ?", args: [id] });
  if (!postRows[0]) { res.status(404).json({ error: "Post not found" }); return; }

  const { rows } = await db.execute({ sql: "SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC", args: [id] });
  const comments = rows as unknown as Comment[];

  const result = await Promise.all(comments.map(async (c) => {
    let liked_by_user = false;
    if (user_id) {
      const { rows: lr } = await db.execute({ sql: "SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?", args: [Number(c.id), user_id] });
      liked_by_user = !!lr[0];
    }
    return { id: c.id, text: c.text, user_id: c.user_id, likes: Number(c.likes), created_at: c.created_at, liked_by_user };
  }));
  res.json(result);
});

// コメントを追加
app.post("/posts/:id/comments", async (req, res) => {
  const postId = Number(req.params.id);
  const { text, user_id } = req.body as { text: string; user_id: string };

  const { rows: postRows } = await db.execute({ sql: "SELECT 1 FROM posts WHERE id = ?", args: [postId] });
  if (!postRows[0]) { res.status(404).json({ error: "Post not found" }); return; }
  if (!text || text.trim() === "") { res.status(400).json({ error: "text is required" }); return; }

  const result = await db.execute({ sql: "INSERT INTO comments (post_id, text, user_id) VALUES (?, ?, ?)", args: [postId, text.trim(), user_id ?? "anonymous"] });
  const { rows } = await db.execute({ sql: "SELECT * FROM comments WHERE id = ?", args: [Number(result.lastInsertRowid)] });
  const comment = rows[0] as unknown as Comment;
  res.status(201).json({ ...comment, likes: Number(comment.likes) });
});

// コメントにいいね
app.post("/comments/:id/like", async (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const { rows: commentRows } = await db.execute({ sql: "SELECT * FROM comments WHERE id = ?", args: [id] });
  if (!commentRows[0]) { res.status(404).json({ error: "Comment not found" }); return; }

  const { rows: likeRows } = await db.execute({ sql: "SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?", args: [id, user_id] });
  if (likeRows[0]) { res.status(400).json({ error: "Already liked" }); return; }

  await db.batch([
    { sql: "INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)", args: [id, user_id] },
    { sql: "UPDATE comments SET likes = likes + 1 WHERE id = ?", args: [id] },
  ], "write");

  const { rows } = await db.execute({ sql: "SELECT * FROM comments WHERE id = ?", args: [id] });
  const updated = rows[0] as unknown as Comment;
  res.json({ id: updated.id, likes: Number(updated.likes) });
});

// コメントいいね取り消し
app.delete("/comments/:id/like", async (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const { rows: commentRows } = await db.execute({ sql: "SELECT * FROM comments WHERE id = ?", args: [id] });
  if (!commentRows[0]) { res.status(404).json({ error: "Comment not found" }); return; }

  const { rows: likeRows } = await db.execute({ sql: "SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?", args: [id, user_id] });
  if (!likeRows[0]) { res.status(400).json({ error: "Not liked yet" }); return; }

  await db.batch([
    { sql: "DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?", args: [id, user_id] },
    { sql: "UPDATE comments SET likes = MAX(0, likes - 1) WHERE id = ?", args: [id] },
  ], "write");

  const { rows } = await db.execute({ sql: "SELECT * FROM comments WHERE id = ?", args: [id] });
  const updated = rows[0] as unknown as Comment;
  res.json({ id: updated.id, likes: Number(updated.likes) });
});

// 返信一覧
app.get("/comments/:id/replies", async (req, res) => {
  const id = Number(req.params.id);
  const { rows: commentRows } = await db.execute({ sql: "SELECT 1 FROM comments WHERE id = ?", args: [id] });
  if (!commentRows[0]) { res.status(404).json({ error: "Comment not found" }); return; }

  const { rows } = await db.execute({ sql: "SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC", args: [id] });
  res.json(rows);
});

// 返信を追加
app.post("/comments/:id/replies", async (req, res) => {
  const commentId = Number(req.params.id);
  const { text, user_id } = req.body as { text: string; user_id: string };

  const { rows: commentRows } = await db.execute({ sql: "SELECT 1 FROM comments WHERE id = ?", args: [commentId] });
  if (!commentRows[0]) { res.status(404).json({ error: "Comment not found" }); return; }
  if (!text || text.trim() === "") { res.status(400).json({ error: "text is required" }); return; }

  const result = await db.execute({ sql: "INSERT INTO comment_replies (comment_id, text, user_id) VALUES (?, ?, ?)", args: [commentId, text.trim(), user_id ?? "anonymous"] });
  const { rows } = await db.execute({ sql: "SELECT * FROM comment_replies WHERE id = ?", args: [Number(result.lastInsertRowid)] });
  res.status(201).json(rows[0]);
});

// 返信を削除
app.delete("/replies/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const { rows } = await db.execute({ sql: "SELECT * FROM comment_replies WHERE id = ?", args: [id] });
  const reply = rows[0] as unknown as Reply | undefined;
  if (!reply) { res.status(404).json({ error: "Reply not found" }); return; }
  if (reply.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  await db.execute({ sql: "DELETE FROM comment_replies WHERE id = ?", args: [id] });
  res.json({ message: "deleted" });
});

// ────────────────────────────────────────
// 桶（フォルダ）エンドポイント
// ────────────────────────────────────────

// 桶一覧
app.get("/buckets", async (req, res) => {
  const { user_id } = req.query as { user_id: string };
  if (!user_id) { res.status(400).json({ error: "user_id is required" }); return; }

  const { rows } = await db.execute({ sql: "SELECT * FROM buckets WHERE user_id = ? ORDER BY created_at DESC", args: [user_id] });
  res.json(rows);
});

// 桶を作成
app.post("/buckets", async (req, res) => {
  const { name, user_id } = req.body as { name: string; user_id: string };
  if (!name || name.trim() === "") { res.status(400).json({ error: "name is required" }); return; }
  if (!user_id) { res.status(400).json({ error: "user_id is required" }); return; }

  const result = await db.execute({ sql: "INSERT INTO buckets (name, user_id) VALUES (?, ?)", args: [name.trim(), user_id] });
  const { rows } = await db.execute({ sql: "SELECT * FROM buckets WHERE id = ?", args: [Number(result.lastInsertRowid)] });
  res.status(201).json(rows[0]);
});

// 桶の中の皿一覧
app.get("/buckets/:id/posts", async (req, res) => {
  const bucketId = Number(req.params.id);
  const { user_id } = req.query as { user_id: string };

  const { rows: bucketRows } = await db.execute({ sql: "SELECT * FROM buckets WHERE id = ?", args: [bucketId] });
  const bucket = bucketRows[0] as unknown as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  const { rows } = await db.execute({ sql: "SELECT p.* FROM posts p INNER JOIN bucket_posts bp ON bp.post_id = p.id WHERE bp.bucket_id = ? ORDER BY bp.id DESC", args: [bucketId] });
  const posts = rows as unknown as Post[];
  res.json(posts.map((p) => ({ ...p, likes: Number(p.likes), views: Number(p.views), spoiler: Number(p.spoiler ?? 0), tier: calcTier(Number(p.likes), Number(p.views)) })));
});

// 桶に皿を追加
app.post("/buckets/:id/posts", async (req, res) => {
  const bucketId = Number(req.params.id);
  const { post_id, user_id } = req.body as { post_id: number; user_id: string };

  const { rows: bucketRows } = await db.execute({ sql: "SELECT * FROM buckets WHERE id = ?", args: [bucketId] });
  const bucket = bucketRows[0] as unknown as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  const { rows: existing } = await db.execute({ sql: "SELECT 1 FROM bucket_posts WHERE bucket_id = ? AND post_id = ?", args: [bucketId, post_id] });
  if (existing[0]) { res.status(400).json({ error: "Already in bucket" }); return; }

  await db.execute({ sql: "INSERT INTO bucket_posts (bucket_id, post_id) VALUES (?, ?)", args: [bucketId, post_id] });
  res.status(201).json({ message: "added" });
});

// 桶から皿を削除
app.delete("/buckets/:id/posts/:postId", async (req, res) => {
  const bucketId = Number(req.params.id);
  const postId   = Number(req.params.postId);
  const { user_id } = req.body as { user_id: string };

  const { rows: bucketRows } = await db.execute({ sql: "SELECT * FROM buckets WHERE id = ?", args: [bucketId] });
  const bucket = bucketRows[0] as unknown as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  await db.execute({ sql: "DELETE FROM bucket_posts WHERE bucket_id = ? AND post_id = ?", args: [bucketId, postId] });
  res.json({ message: "removed" });
});

// 桶を削除
app.delete("/buckets/:id", async (req, res) => {
  const bucketId = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const { rows: bucketRows } = await db.execute({ sql: "SELECT * FROM buckets WHERE id = ?", args: [bucketId] });
  const bucket = bucketRows[0] as unknown as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  await db.batch([
    { sql: "DELETE FROM bucket_posts WHERE bucket_id = ?", args: [bucketId] },
    { sql: "DELETE FROM buckets WHERE id = ?", args: [bucketId] },
  ], "write");
  res.json({ message: "deleted" });
});

// ────────────────────────────────────────
// サーバー起動
// ────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`)))
  .catch((e) => { console.error("DB init failed:", e); process.exit(1); });
