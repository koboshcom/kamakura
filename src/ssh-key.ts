// Runs only inside the authenticated owner's sandbox. No private key bytes
// leave /workspace/.ssh; sandbox commands are serialized per owner.
export const sshKeyCommand = `set -euo pipefail
umask 077
dir=/workspace/.ssh
key="$dir/id_ed25519"
[ ! -L "$dir" ] || { echo 'SSH directory must not be a symlink' >&2; exit 1; }
mkdir -p "$dir"
[ -d "$dir" ] && [ "$(stat -c %u "$dir")" = "$(id -u)" ] || exit 1
chmod 700 "$dir"
for file in "$key" "$key.pub"; do
  [ ! -L "$file" ] || { echo 'SSH files must not be symlinks' >&2; exit 1; }
  if [ -e "$file" ]; then
    [ -f "$file" ] && [ "$(stat -c %h "$file")" = 1 ] && [ "$(stat -c %u "$file")" = "$(id -u)" ] || exit 1
  fi
done
if [ ! -e "$key" ]; then
  ssh-keygen -q -t ed25519 -N '' -C kamakura-sandbox -f "$key" </dev/null
fi
chmod 600 "$key"
public=$(ssh-keygen -y -P '' -f "$key" </dev/null)
read -r kind data comment <<< "$public"
[ "$kind" = ssh-ed25519 ] || { echo 'Existing key is not ed25519; not replacing it' >&2; exit 1; }
public="$kind $data"
tmp=$(mktemp "$dir/.public.XXXXXX")
trap 'rm -f "$tmp"' EXIT
printf '%s kamakura-sandbox\\n' "$public" > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$key.pub"
printf '%s kamakura-sandbox\\n' "$public"
`;

export async function sandboxPublicKey(run: (command: string) => Promise<{ output: string; exitCode: number | null; timedOut: boolean }>): Promise<{ publicKey: string; path: string }> {
  const result = await run(sshKeyCommand);
  const publicKey = result.output.trim();
  if (result.exitCode !== 0 || result.timedOut || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} kamakura-sandbox$/.test(publicKey)) {
    // Do not include shell output or private material in exceptions.
    throw new Error('Could not safely create or read the sandbox SSH public key');
  }
  return { publicKey, path: '/workspace/.ssh/id_ed25519.pub' };
}
