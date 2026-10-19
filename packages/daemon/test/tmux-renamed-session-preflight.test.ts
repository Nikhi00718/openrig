// tmux replaces "." with "_" in a session name, so a seat launched as dev-impl@demo.v2 runs as
// dev-impl@demo_v2 and every later lookup by the recorded name misses it. Managed launch preflight
// refuses such a name on the pod and legacy paths; validation, review and bundling are unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { tmuxRenamedSessionError } from "../src/domain/session-name.js";
import type { PodRigSpec } from "../src/domain/types.js";

function podSpec(name: string): PodRigSpec {
  return {
    version: "0.2",
    name,
    pods: [{
      id: "crew",
      label: "Crew",
      members: [{ id: "a", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "/tmp" }],
      edges: [],
    }],
    edges: [],
  } as unknown as PodRigSpec;
}

function flatSpec(name: string) {
  return { schemaVersion: 1, name, version: "1.0.0", nodes: [{ id: "solo", runtime: "claude-code" as const, role: "worker", cwd: "/" }], edges: [] };
}

const renamed = (session: string) => `would create it as "${session}"`;

describe("tmuxRenamedSessionError", () => {
  it("names the session tmux would create, and accepts names tmux keeps", () => {
    expect(tmuxRenamedSessionError("crew-a@demo.v2")).toContain(renamed("crew-a@demo_v2"));
    expect(tmuxRenamedSessionError("r00-demo.v2-solo")).toContain(renamed("r00-demo_v2-solo"));
    for (const name of ["crew-a@demo-v2", "crew-a@demo_v2", "r00-demo-v2-solo"]) {
      expect(tmuxRenamedSessionError(name)).toBeNull();
    }
  });
});

describe("a dotted rig name outside launch is unchanged", () => {
  it("still validates and reviews", () => {
    const pod = RigSpecCodec.parse(RigSpecCodec.serialize(podSpec("demo.v2")));
    expect(RigSpecSchema.validate(pod)).toMatchObject({ valid: true });
    expect(LegacyRigSpecSchema.validate({ schema_version: 1, name: "demo.v2", version: "1.0", nodes: [{ id: "solo", runtime: "claude-code" }], edges: [] }))
      .toMatchObject({ valid: true });
    const review = new SpecReviewService().reviewRigSpec(RigSpecCodec.serialize(podSpec("demo.v2")), "draft");
    expect(review).toMatchObject({ name: "demo.v2" });
  });
});

describe("managed launch refuses a session name tmux would rename", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  const createSession = () => (setup.tmuxAdapter as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  it("pod rig up: preflight fails before any session is created", async () => {
    const result = await setup.podInstantiator.instantiate(RigSpecCodec.serialize(podSpec("demo.v2")), "/tmp");
    expect(result).toMatchObject({ ok: false, code: "preflight_failed" });
    expect(((result as { errors?: string[] }).errors ?? []).join(" ")).toContain(renamed("crew-a@demo_v2"));
    expect(createSession()).not.toHaveBeenCalled();
    expect(setup.rigRepo.listRigs().map((r) => r.name)).not.toContain("demo.v2");
  });

  it("pod rig up control: a name without dots launches", async () => {
    const result = await setup.podInstantiator.instantiate(RigSpecCodec.serialize(podSpec("demo-v2")), "/tmp");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(createSession()).toHaveBeenCalledWith("crew-a@demo-v2", expect.anything(), expect.anything());
  });

  it("legacy instantiate: preflight fails before any session is created", async () => {
    const result = await setup.rigInstantiator.instantiate(flatSpec("demo.v2") as never);
    expect(result).toMatchObject({ ok: false, code: "preflight_failed" });
    expect(((result as { errors?: string[] }).errors ?? []).join(" ")).toContain(renamed("r00-demo_v2-solo"));
    expect(createSession()).not.toHaveBeenCalled();
  });

  it("legacy instantiate control: a name without dots launches", async () => {
    const result = await setup.rigInstantiator.instantiate(flatSpec("demo-v2") as never);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(createSession()).toHaveBeenCalledWith("r00-demo-v2-solo", expect.anything(), expect.anything());
  });

  it("adding a member to an existing dotted rig is refused before its session is created", async () => {
    // An existing rig whose name has a dot (stored before this check, or created outside a spec).
    const rig = setup.rigRepo.createRig("demo-v2");
    const seeded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "crew", label: "Crew", members: [{ id: "a", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "/tmp" }], edges: [] } });
    expect(seeded.ok).toBe(true);
    db.prepare("UPDATE rigs SET name = ? WHERE id = ?").run("demo.v2", rig.id);
    createSession().mockClear();

    const member = { id: "b", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" };
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "crew", member, ".");
    expect(result).toMatchObject({ ok: false, code: "preflight_failed" });
    expect(((result as { errors?: string[] }).errors ?? []).join(" ")).toContain(renamed("crew-b@demo_v2"));
    expect(createSession()).not.toHaveBeenCalled();
    expect(setup.rigRepo.getRig(rig.id)!.nodes.map((n) => n.logicalId)).toEqual(["crew.a"]);
  });
});
