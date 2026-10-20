import type Database from "better-sqlite3";
import { resolveActiveOccupantRow, resolveActiveSnapshotSession } from "./active-occupant.js";
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";
import type { RigWithRelations, Snapshot } from "./types.js";

export interface CurrentStateRehydrateEligibility {
  ok: boolean;
  blockers: string[];
}

/**
 * A crash snapshot remains trustworthy only while it names every occupant that
 * durable current state still identifies as active. Boot reconciliation turns
 * rows detached after abrupt substrate loss, so detached rows must participate:
 * a different session id or native resume identity is positive evidence that
 * the snapshot belongs to an older occupant. Ambiguous current state is also
 * not permission to revive a historical occupant; current-state capture
 * preserves the ambiguity and restore refuses it explicitly.
 */
export function assessSnapshotCurrentOccupants(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: Snapshot,
): { matches: boolean; stoppedFreshNodeIds: Set<string> } {
  const stoppedFreshNodeIds = new Set<string>();
  const mismatch = () => ({ matches: false, stoppedFreshNodeIds: new Set<string>() });
  if (rig.nodes.length === 0) return { matches: true, stoppedFreshNodeIds };
  const rows = db.prepare(
    `SELECT s.*, s.node_id AS nodeId,
            s.resume_type AS resumeType, s.resume_token AS resumeToken
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       WHERE n.rig_id = ? AND s.status != 'superseded'`
  ).all(rig.rig.id) as Array<{
    id: string;
    nodeId: string;
    status: string;
    resumeType: string | null;
    resumeToken: string | null;
    intentionally_stopped?: number;
  }>;

  const recorded = readFreshOccupantRelations(db, rig.rig.id);
  // A clean down exits the fresh occupant without revoking its relation.
  // Keep that row for snapshot comparison, but exclude unrelated exited history.
  const candidates = rows.filter((row) => row.status !== "exited" || recorded[row.nodeId] === row.id);
  for (const node of rig.nodes) {
    const current = resolveActiveOccupantRow(candidates, Object.prototype.hasOwnProperty.call(recorded, node.id) ? recorded : undefined, node.id);
    if (current.kind === "none") continue;
    if (current.kind === "ambiguous") return mismatch();
    const captured = resolveActiveSnapshotSession(snapshot.data, node.id);
    const stoppedHistory = snapshot.data.sessions.filter(s => s.nodeId === node.id && s.id === current.session.id);
    // An absent occupant is current only with the deliberate stop, the exact
    // exited/native history, and a fresh effect fenced to the current tenure.
    // Missing/ambiguous legacy relations never qualify as recorded absence.
    if (captured.kind === "none" && snapshot.data.activeOccupantsByNode?.[node.id]?.kind === "absent"
      && current.session.status === "exited" && current.session.intentionally_stopped === 1
      && recorded[node.id] === current.session.id && stoppedHistory.length === 1
      && stoppedHistory[0]!.status === "exited"
      && (stoppedHistory[0]!.resumeType ?? null) === current.session.resumeType
      && (stoppedHistory[0]!.resumeToken ?? null) === current.session.resumeToken
      && (db.prepare("SELECT kind FROM occupant_tenures WHERE node_id=? ORDER BY generation_ordinal DESC LIMIT 1").get(node.id) as { kind: string } | undefined)?.kind === "fresh") {
      stoppedFreshNodeIds.add(node.id);
      continue;
    }
    if (
      captured.kind !== "resolved"
      || captured.session.id !== current.session.id
      || (captured.session.resumeType ?? null) !== current.session.resumeType
      || (captured.session.resumeToken ?? null) !== current.session.resumeToken
    ) {
      return mismatch();
    }
  }
  return { matches: true, stoppedFreshNodeIds };
}

export function snapshotMatchesCurrentOccupants(db: Database.Database, rig: RigWithRelations, snapshot: Snapshot): boolean {
  return assessSnapshotCurrentOccupants(db, rig, snapshot).matches;
}

export function stoppedFreshSnapshotReason(logicalId: string): string {
  return `Seat '${logicalId}' was deliberately stopped in the current fresh generation and this snapshot. It remains stopped; choose an explicit per-seat launch to start it.`;
}

/**
 * Determines whether current persisted DB state is sufficient to synthesize a
 * restore snapshot after volatile runtime state (tmux) disappeared.
 *
 * This is intentionally conservative. It does not claim provider continuity by
 * itself; it only says the existing restore orchestrator has enough persisted
 * input to attempt a normal restore from an on-demand snapshot.
 */
export function assessCurrentStateRehydrateEligibility(
  db: Database.Database,
  rig: RigWithRelations,
): CurrentStateRehydrateEligibility {
  const blockers: string[] = [];

  if (rig.nodes.length === 0) {
    blockers.push("rig has no nodes to rehydrate");
  }

  const sessions = db.prepare(
    `SELECT node_id, resume_token
       FROM sessions
       WHERE node_id IN (${rig.nodes.map(() => "?").join(",") || "NULL"})
         AND status NOT IN ('superseded', 'exited')
       ORDER BY id DESC`
  ).all(...rig.nodes.map((node) => node.id)) as Array<{ node_id: string; resume_token: string | null }>;

  if (rig.nodes.length > 0 && sessions.length === 0) {
    blockers.push("rig has no persisted sessions to rehydrate");
  }

  const sessionByNode = new Map<string, Array<{ resume_token: string | null }>>();
  for (const session of sessions) {
    const rows = sessionByNode.get(session.node_id) ?? [];
    rows.push(session);
    sessionByNode.set(session.node_id, rows);
  }

  for (const node of rig.nodes) {
    const runtime = node.runtime ?? "";
    const isAgentRuntime = runtime.length > 0 && runtime !== "terminal";
    const hasStartupContext = !!db.prepare(
      "SELECT 1 FROM node_startup_context WHERE node_id = ? LIMIT 1"
    ).get(node.id);
    const hasResumeToken = (sessionByNode.get(node.id) ?? []).some((session) =>
      typeof session.resume_token === "string" && session.resume_token.length > 0
    );

    if (node.podId && !hasStartupContext) {
      blockers.push(`node ${node.logicalId} is pod-aware but has no persisted startup context`);
      continue;
    }

    if (isAgentRuntime && !hasStartupContext && !hasResumeToken) {
      blockers.push(`node ${node.logicalId} has runtime ${runtime} but no startup context or resume token`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}
