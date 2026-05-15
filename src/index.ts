import express from "express";
import cors from "cors";
import Database from "better-sqlite3";

const app = express();
app.use(cors());
app.use(express.json());

// ────────────────────────────────────────
// DB 初期化
// ────────────────────────────────────────
const db = new Database("sushi.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT    NOT NULL,
    likes      INTEGER NOT NULL DEFAULT 0,
    views      INTEGER NOT NULL DEFAULT 0,
    user_id    TEXT    NOT NULL DEFAULT 'system',
    room       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    spoiler    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    user_id    TEXT    NOT NULL DEFAULT 'system',
    likes      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS comment_likes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    user_id    TEXT    NOT NULL,
    FOREIGN KEY (comment_id) REFERENCES comments(id)
  );

  CREATE TABLE IF NOT EXISTS post_likes (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id TEXT    NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS buckets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bucket_posts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_id INTEGER NOT NULL,
    post_id   INTEGER NOT NULL,
    FOREIGN KEY (bucket_id) REFERENCES buckets(id),
    FOREIGN KEY (post_id)   REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS comment_replies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (comment_id) REFERENCES comments(id)
  );
`);

// spoiler カラムがなければ追加（既存DBマイグレーション）
try { db.exec("ALTER TABLE posts ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0"); } catch {}

// テーブルが空のときだけ初期データを入れる
const postCount = (db.prepare("SELECT COUNT(*) as cnt FROM posts").get() as { cnt: number }).cnt;
if (postCount === 0) {
  const insertPost = db.prepare("INSERT INTO posts (content, likes, views, user_id, room) VALUES (?, ?, ?, ?, ?)");
  const insertComment = db.prepare("INSERT INTO comments (post_id, text, user_id) VALUES (?, ?, ?)");

  const p1 = insertPost.run("エレンの決断は正しかったのか？", 342, 490, "system", "キャラ考察");
  const p2 = insertPost.run("鬼滅の刃3期の作画がやばい", 187, 467, "system", "最新話速報");
  const p3 = insertPost.run("ルフィのギア5、原作とアニメどっちが好き？", 45, 300, "system", "キャラ考察");

  insertComment.run(p1.lastInsertRowid, "この考察最高すぎる", "system");
  insertComment.run(p1.lastInsertRowid, "アニメ見直した", "system");
  insertComment.run(p2.lastInsertRowid, "ufotableは毎回やばい", "system");
  insertComment.run(p3.lastInsertRowid, "アニメのギア5は笑いすぎた", "system");
}

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
// 型定義
// ────────────────────────────────────────
type Post    = { id: number; content: string; likes: number; views: number; user_id: string; room: string; created_at: string };
type Comment = { id: number; post_id: number; text: string; user_id: string; likes: number; created_at: string };
type Bucket  = { id: number; name: string; user_id: string; created_at: string };
type Reply   = { id: number; comment_id: number; text: string; user_id: string; created_at: string };

// ────────────────────────────────────────
// 投稿エンドポイント
// ────────────────────────────────────────

// 投稿一覧
app.get("/posts", (_req, res) => {
  const posts = db.prepare("SELECT * FROM posts ORDER BY created_at DESC").all() as Post[];
  const result = posts.map((p) => ({
    id: p.id,
    content: p.content,
    likes: p.likes,
    views: p.views,
    user_id: p.user_id,
    room: p.room,
    created_at: p.created_at,
    spoiler: p.spoiler ?? 0,
    tier: calcTier(p.likes, p.views),
  }));
  res.json(result);
});

// 投稿を作成
app.post("/posts", (req, res) => {
  const { content, user_id, room, spoiler } = req.body as { content: string; user_id: string; room: string; spoiler?: boolean };

  if (!content || content.trim() === "") {
    res.status(400).json({ error: "content is required" });
    return;
  }
  if (!user_id) {
    res.status(400).json({ error: "user_id is required" });
    return;
  }

  const result = db.prepare(
    "INSERT INTO posts (content, user_id, room, spoiler) VALUES (?, ?, ?, ?)"
  ).run(content.trim(), user_id, room ?? "", spoiler ? 1 : 0);

  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(result.lastInsertRowid) as Post;
  res.status(201).json({ ...post, tier: calcTier(post.likes, post.views) });
});

// 投稿を削除
app.delete("/posts/:id", (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }
  if (post.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  res.json({ message: "deleted" });
});

// いいね
app.post("/posts/:id/like", (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }

  const existing = db.prepare("SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?").get(id, user_id);
  if (existing) { res.status(400).json({ error: "Already liked" }); return; }

  db.prepare("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)").run(id, user_id);
  db.prepare("UPDATE posts SET likes = likes + 1 WHERE id = ?").run(id);

  const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post;
  res.json({ id: updated.id, likes: updated.likes, tier: calcTier(updated.likes, updated.views) });
});

// いいね取り消し
app.delete("/posts/:id/like", (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }

  const existing = db.prepare("SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?").get(id, user_id);
  if (!existing) { res.status(400).json({ error: "Not liked yet" }); return; }

  db.prepare("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?").run(id, user_id);
  db.prepare("UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = ?").run(id);

  const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post;
  res.json({ id: updated.id, likes: updated.likes, tier: calcTier(updated.likes, updated.views) });
});

// ────────────────────────────────────────
// コメントエンドポイント
// ────────────────────────────────────────

// コメント一覧
app.get("/posts/:id/comments", (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.query as { user_id?: string };

  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }

  const comments = db.prepare("SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC").all(id) as Comment[];
  res.json(comments.map((c) => ({
    id: c.id,
    text: c.text,
    user_id: c.user_id,
    likes: c.likes,
    created_at: c.created_at,
    liked_by_user: user_id
      ? !!db.prepare("SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?").get(c.id, user_id)
      : false,
  })));
});

// コメントを追加
app.post("/posts/:id/comments", (req, res) => {
  const postId = Number(req.params.id);
  const { text, user_id } = req.body as { text: string; user_id: string };

  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as Post | undefined;
  if (!post) { res.status(404).json({ error: "Post not found" }); return; }
  if (!text || text.trim() === "") { res.status(400).json({ error: "text is required" }); return; }

  const result = db.prepare(
    "INSERT INTO comments (post_id, text, user_id) VALUES (?, ?, ?)"
  ).run(postId, text.trim(), user_id ?? "anonymous");

  const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(result.lastInsertRowid) as Comment;
  res.status(201).json(comment);
});

// コメントにいいね
app.post("/comments/:id/like", (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Comment | undefined;
  if (!comment) { res.status(404).json({ error: "Comment not found" }); return; }

  const existing = db.prepare("SELECT * FROM comment_likes WHERE comment_id = ? AND user_id = ?").get(id, user_id);
  if (existing) { res.status(400).json({ error: "Already liked" }); return; }

  db.prepare("INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)").run(id, user_id);
  db.prepare("UPDATE comments SET likes = likes + 1 WHERE id = ?").run(id);

  const updated = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Comment;
  res.json({ id: updated.id, likes: updated.likes });
});

// コメントいいね取り消し
app.delete("/comments/:id/like", (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Comment | undefined;
  if (!comment) { res.status(404).json({ error: "Comment not found" }); return; }

  const existing = db.prepare("SELECT * FROM comment_likes WHERE comment_id = ? AND user_id = ?").get(id, user_id);
  if (!existing) { res.status(400).json({ error: "Not liked yet" }); return; }

  db.prepare("DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?").run(id, user_id);
  db.prepare("UPDATE comments SET likes = MAX(0, likes - 1) WHERE id = ?").run(id);

  const updated = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Comment;
  res.json({ id: updated.id, likes: updated.likes });
});

// 返信一覧
app.get("/comments/:id/replies", (req, res) => {
  const id = Number(req.params.id);
  const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Comment | undefined;
  if (!comment) { res.status(404).json({ error: "Comment not found" }); return; }

  const replies = db.prepare("SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC").all(id) as Reply[];
  res.json(replies);
});

// 返信を追加
app.post("/comments/:id/replies", (req, res) => {
  const commentId = Number(req.params.id);
  const { text, user_id } = req.body as { text: string; user_id: string };

  const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(commentId) as Comment | undefined;
  if (!comment) { res.status(404).json({ error: "Comment not found" }); return; }
  if (!text || text.trim() === "") { res.status(400).json({ error: "text is required" }); return; }

  const result = db.prepare(
    "INSERT INTO comment_replies (comment_id, text, user_id) VALUES (?, ?, ?)"
  ).run(commentId, text.trim(), user_id ?? "anonymous");

  const reply = db.prepare("SELECT * FROM comment_replies WHERE id = ?").get(result.lastInsertRowid) as Reply;
  res.status(201).json(reply);
});

// 返信を削除
app.delete("/replies/:id", (req, res) => {
  const id = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const reply = db.prepare("SELECT * FROM comment_replies WHERE id = ?").get(id) as Reply | undefined;
  if (!reply) { res.status(404).json({ error: "Reply not found" }); return; }
  if (reply.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  db.prepare("DELETE FROM comment_replies WHERE id = ?").run(id);
  res.json({ message: "deleted" });
});

// ────────────────────────────────────────
// 桶（フォルダ）エンドポイント
// ────────────────────────────────────────

// 桶一覧
app.get("/buckets", (req, res) => {
  const { user_id } = req.query as { user_id: string };
  if (!user_id) { res.status(400).json({ error: "user_id is required" }); return; }

  const buckets = db.prepare("SELECT * FROM buckets WHERE user_id = ? ORDER BY created_at DESC").all(user_id) as Bucket[];
  res.json(buckets);
});

// 桶を作成
app.post("/buckets", (req, res) => {
  const { name, user_id } = req.body as { name: string; user_id: string };

  if (!name || name.trim() === "") { res.status(400).json({ error: "name is required" }); return; }
  if (!user_id) { res.status(400).json({ error: "user_id is required" }); return; }

  const result = db.prepare("INSERT INTO buckets (name, user_id) VALUES (?, ?)").run(name.trim(), user_id);
  const bucket = db.prepare("SELECT * FROM buckets WHERE id = ?").get(result.lastInsertRowid) as Bucket;
  res.status(201).json(bucket);
});

// 桶の中の皿一覧
app.get("/buckets/:id/posts", (req, res) => {
  const bucketId = Number(req.params.id);
  const { user_id } = req.query as { user_id: string };

  const bucket = db.prepare("SELECT * FROM buckets WHERE id = ?").get(bucketId) as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  const posts = db.prepare(`
    SELECT p.* FROM posts p
    INNER JOIN bucket_posts bp ON bp.post_id = p.id
    WHERE bp.bucket_id = ?
    ORDER BY bp.id DESC
  `).all(bucketId) as Post[];

  res.json(posts.map((p) => ({ ...p, tier: calcTier(p.likes, p.views) })));
});

// 桶に皿を追加
app.post("/buckets/:id/posts", (req, res) => {
  const bucketId = Number(req.params.id);
  const { post_id, user_id } = req.body as { post_id: number; user_id: string };

  const bucket = db.prepare("SELECT * FROM buckets WHERE id = ?").get(bucketId) as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  const existing = db.prepare("SELECT * FROM bucket_posts WHERE bucket_id = ? AND post_id = ?").get(bucketId, post_id);
  if (existing) { res.status(400).json({ error: "Already in bucket" }); return; }

  db.prepare("INSERT INTO bucket_posts (bucket_id, post_id) VALUES (?, ?)").run(bucketId, post_id);
  res.status(201).json({ message: "added" });
});

// 桶から皿を削除
app.delete("/buckets/:id/posts/:postId", (req, res) => {
  const bucketId = Number(req.params.id);
  const postId   = Number(req.params.postId);
  const { user_id } = req.body as { user_id: string };

  const bucket = db.prepare("SELECT * FROM buckets WHERE id = ?").get(bucketId) as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  db.prepare("DELETE FROM bucket_posts WHERE bucket_id = ? AND post_id = ?").run(bucketId, postId);
  res.json({ message: "removed" });
});

// 桶を削除
app.delete("/buckets/:id", (req, res) => {
  const bucketId = Number(req.params.id);
  const { user_id } = req.body as { user_id: string };

  const bucket = db.prepare("SELECT * FROM buckets WHERE id = ?").get(bucketId) as Bucket | undefined;
  if (!bucket) { res.status(404).json({ error: "Bucket not found" }); return; }
  if (bucket.user_id !== user_id) { res.status(403).json({ error: "Permission denied" }); return; }

  db.prepare("DELETE FROM bucket_posts WHERE bucket_id = ?").run(bucketId);
  db.prepare("DELETE FROM buckets WHERE id = ?").run(bucketId);
  res.json({ message: "deleted" });
});

// ────────────────────────────────────────
// サーバー起動
// ────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
