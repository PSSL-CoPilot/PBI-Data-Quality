/**
 * Version history. Extraction itself runs in the browser and the PBIX bytes
 * never leave the machine; only the normalized metadata is stored here, which
 * is what the privacy-first design in docs/ARCHITECTURE.md promises.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { projects, versions } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";

/** Signed-out local development still needs a stable owner for its rows. */
const LOCAL_USER = { userId: "local", email: "local@localhost" };
const DEFAULT_PROJECT_NAME = "My Power BI project";

async function currentUser() {
  return (await getChatGPTUser()) ?? LOCAL_USER;
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const missingTable = message.includes("no such table");
  return Response.json(
    {
      error: missingTable
        ? "The version tables are not created yet. Run `npm run db:generate` and deploy so D1 applies the migration."
        : message,
      // Analysis is client-side, so the caller can keep working without us.
      persisted: false,
    },
    { status: missingTable ? 503 : 500 }
  );
}

type Db = ReturnType<typeof getDb>;

async function defaultProjectId(db: Db, userId: string): Promise<string> {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.ownerUserId, userId), eq(projects.name, DEFAULT_PROJECT_NAME)))
    .limit(1);
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await db.insert(projects).values({
    id,
    organizationId: userId,
    name: DEFAULT_PROJECT_NAME,
    ownerUserId: userId,
    createdAt: Date.now(),
  });
  return id;
}

export async function GET() {
  try {
    const db = getDb();
    const user = await currentUser();
    const projectId = await defaultProjectId(db, user.userId);

    const rows = await db
      .select({
        id: versions.id,
        fileName: versions.fileName,
        sha256: versions.sha256,
        extractionStatus: versions.extractionStatus,
        extractionReason: versions.extractionReason,
        createdAt: versions.createdAt,
      })
      .from(versions)
      .where(eq(versions.projectId, projectId))
      .orderBy(desc(versions.createdAt))
      .limit(50);

    return Response.json({ versions: rows });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      fileName?: string;
      sha256?: string;
      status?: string;
      reason?: string;
      metadata?: unknown;
    };

    const fileName = payload.fileName?.trim();
    const sha256 = payload.sha256?.trim();
    if (!fileName || !sha256) {
      return Response.json({ error: "fileName and sha256 are required" }, { status: 400 });
    }

    const db = getDb();
    const user = await currentUser();
    const projectId = await defaultProjectId(db, user.userId);

    const id = crypto.randomUUID();
    await db.insert(versions).values({
      id,
      projectId,
      fileName,
      sha256,
      metadataJson: payload.metadata ? JSON.stringify(payload.metadata) : null,
      extractionStatus: payload.status ?? "unknown",
      extractionReason: payload.reason ?? null,
      createdAt: Date.now(),
    });

    return Response.json({ id, projectId, persisted: true }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
