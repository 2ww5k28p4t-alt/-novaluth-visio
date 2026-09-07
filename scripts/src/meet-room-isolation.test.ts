import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

const roomGeneratorModule = path.join(scriptsDirectory, "meet-test-room.ts");

function createRoomInSeparateProcess() {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "--eval",
        `import(${JSON.stringify(roomGeneratorModule)}).then(({ createMeetTestRoom }) => console.log(createMeetTestRoom()))`,
      ],
      {
        cwd: path.resolve(scriptsDirectory, ".."),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `Le processus de validation Meet a échoué (code=${code}, signal=${signal}) : ${stderr || stdout}`,
          ),
        );
        return;
      }
      const room = stdout.trim();
      if (!/^reprise-[a-z0-9-]+-[a-z0-9]+$/.test(room)) {
        reject(new Error(`Identifiant de salle Meet invalide : ${JSON.stringify(room)}`));
        return;
      }
      resolve(room);
    });
  });
}

const [firstRoom, secondRoom] = await Promise.all([
  createRoomInSeparateProcess(),
  createRoomInSeparateProcess(),
]);

if (firstRoom === secondRoom) {
  throw new Error(`Deux validations Meet ont produit la même salle : ${firstRoom}`);
}

console.log("Meet room isolation passed: deux processus ont produit des salles distinctes.");
