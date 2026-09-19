'use strict';
// Native packages use both darwin-arm64 and darwin_arm64 spellings.
function isForeignRuntime(name, target) {
  const match = name.match(/(darwin|win32|linux|freebsd|android|openbsd|sunos)[-_](arm64|x64|ia32|arm|riscv64|loong64|ppc64|s390x)/);
  return Boolean(match && `${match[1]}-${match[2]}` !== target);
}
module.exports = { isForeignRuntime };
