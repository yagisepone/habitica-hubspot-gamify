import fs from "fs";
import yaml from "js-yaml";

const usersYml = yaml.load(fs.readFileSync("config/users.yml","utf8")) as any;
const membersJson = JSON.parse(fs.readFileSync("config/members.json","utf8"));
const ids = new Set<string>(); const dup: string[] = [];

for (const m of (usersYml?.members || [])) {
  const id = String(m.hubspot_owner_id || "");
  if (!id) console.log(`[WARN] hubspot_owner_id missing key=${m.key}`);
  if (ids.has(id)) dup.push(id);
  ids.add(id);
  if (typeof m.hubspot_owner_id !== "string") {
    console.log(`[ERROR] hubspot_owner_id must be string: key=${m.key}`);
  }
  if (m.habitica_user_id && !m.habitica_api_token) {
    console.log(`[WARN] habitica_api_token missing for key=${m.key}`);
  }
}
for (const id of Object.keys(membersJson)) {
  if (!ids.has(id)) console.log(`[WARN] members.json contains unmapped id=${id}`);
}
if (dup.length) {
  console.log(`[ERROR] duplicated ownerIds:`, dup);
  process.exitCode = 1;
} else {
  console.log(`validate_members: OK`);
}
