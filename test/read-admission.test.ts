import { expect, test } from "bun:test";
import { AdmissionWakeup, type ReadAdmission } from "../web/core/read-admission";

function policy() {
  const listeners = new Set<() => void>();
  const admission: ReadAdmission = {
    allows: () => true,
    subscribeChanged: (wake) => { listeners.add(wake); return () => { listeners.delete(wake); }; },
  };
  return { admission, listeners, change: () => { for (const wake of [...listeners]) wake(); } };
}

test("an idle reader retains no policy subscription; bursts wake it once", async () => {
  const p = policy(); let pumps = 0;
  const wakeup = new AdmissionWakeup(p.admission, () => { pumps++; });
  wakeup.update(false); p.change();
  expect(p.listeners.size).toBe(0);
  wakeup.update(true); wakeup.update(true);
  expect(p.listeners.size).toBe(1);
  p.change(); p.change(); p.change();
  expect(pumps).toBe(0);
  await Promise.resolve();
  expect(pumps).toBe(1);
  wakeup.update(false);
  expect(p.listeners.size).toBe(0);
});

test("cancelling the final queued read suppresses an already scheduled wake", async () => {
  const p = policy(); let pumps = 0;
  const wakeup = new AdmissionWakeup(p.admission, () => { pumps++; });
  wakeup.update(true); p.change(); wakeup.update(false);
  await Promise.resolve(); p.change(); await Promise.resolve();
  expect(pumps).toBe(0);
  expect(p.listeners.size).toBe(0);
});

test("new work before a scheduled wake is serviced, including changes during pumping", async () => {
  const p = policy(); let pumps = 0;
  const wakeup = new AdmissionWakeup(p.admission, () => { if (++pumps === 1) p.change(); else wakeup.update(false); });
  wakeup.update(true); p.change(); wakeup.update(false); wakeup.update(true); p.change();
  await Promise.resolve(); await Promise.resolve();
  expect(pumps).toBe(2);
  expect(p.listeners.size).toBe(0);
});

test("policy changes wake all waiting readers independently", async () => {
  const p = policy(); const pumped: number[] = [];
  const a = new AdmissionWakeup(p.admission, () => { pumped.push(1); a.update(false); });
  const b = new AdmissionWakeup(p.admission, () => { pumped.push(2); b.update(false); });
  a.update(true); b.update(true); p.change();
  await Promise.resolve();
  expect(pumped).toEqual([1, 2]);
  expect(p.listeners.size).toBe(0);
});
