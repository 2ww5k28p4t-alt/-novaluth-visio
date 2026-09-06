import { randomUUID } from "node:crypto";

const roomProcessEntropy = `${process.pid.toString(36)}-${randomUUID().replaceAll("-", "")}`;
let roomSequence = 0;

export function createMeetTestRoom() {
  roomSequence += 1;
  return `reprise-${roomProcessEntropy}-${roomSequence.toString(36)}`;
}