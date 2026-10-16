#!/usr/bin/env bash
# sangue-suga v5.0.0 - empacotador de código para contexto de IA.
# Dependências: Bash 4+, awk, find, grep, sort, stat, sha256sum, cmp, fold, wc, git (opcional).
set -Eeuo pipefail
IFS=$'\n\t'

VERSION='5.0.0'
PROG='sangue-suga'
ROOT='.'
TOKENS=100000
MODE='compacto'           # padrão: remover comentários reconhecidos; seguro é explícito
SAFETY_PERCENT=20         # margem para estimativa local aproximada
DEBUG=1                   # diagnóstico detalhado por padrão
QUIET=0
INTERACTIVE=0
NO_GIT=0
FOLLOW_LINKS=1            # escolha do usuário: seguir todos os links
INCLUDE_HIDDEN=1
OUTPUT_DIR_NAME='.repo-pack'

CANDIDATES=0
SELECTED=0
PROCESSED=0
SKIPPED=0
FAILED=0
BINARIES=0
DUPLICATES=0
PARTS=0
INPUT_CHARS=0
OUTPUT_CHARS=0

usage() {
  cat <<'HELP'
Uso:
  ./sangue-suga-v5.sh [diretório] [opções]

Opções:
  --tokens N             orçamento estimado por parte (padrão: 100000)
  --tokens=N             forma alternativa
  --modo seguro|compacto|sem-minificar
                         seguro preserva conteúdo; compacto tenta remover
                         comentários apenas em sintaxes reconhecidas;
                         sem-minificar preserva os arquivos textuais
  --margem N              margem percentual (padrão: 20; intervalo 5..50)
  --sem-git               usar find em vez da lista do Git
  --sem-ocultos           ignorar caminhos ocultos
  --quiet                 reduzir progresso (erros e resumo continuam)
  --debug                 habilitar diagnóstico detalhado
  -h, --help              mostrar ajuda
  --versao                mostrar versão

Saída:
  .repo-pack/NOME.txt, se houver uma parte;
  .repo-pack/NOME-parte001.txt, ... se houver várias partes;
  .repo-pack/relatorio-NOME.txt com inventário, duplicatas e falhas.

A contagem de tokens é uma estimativa local baseada em caracteres, não um
contador exato de tokenizer. Uma margem de segurança é aplicada ao orçamento.
HELP
}
log() { (( DEBUG )) && printf '[diagnóstico] %s\n' "$*" >&2 || true; }
info() { (( QUIET )) || printf '[progresso] %s\n' "$*" >&2; }
warn() { printf '[aviso] %s\n' "$*" >&2; }
die() { printf '[erro] %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --versao|--version) printf '%s %s\n' "$PROG" "$VERSION"; exit 0 ;;
    --tokens) (($# >= 2)) || die 'faltou valor para --tokens'; TOKENS=$2; shift 2 ;;
    --tokens=*) TOKENS=${1#*=}; shift ;;
    --modo) (($# >= 2)) || die 'faltou valor para --modo'; MODE=$2; shift 2 ;;
    --modo=*) MODE=${1#*=}; shift ;;
    --margem) (($# >= 2)) || die 'faltou valor para --margem'; SAFETY_PERCENT=$2; shift 2 ;;
    --margem=*) SAFETY_PERCENT=${1#*=}; shift ;;
    --sem-git) NO_GIT=1; shift ;;
    --sem-ocultos) INCLUDE_HIDDEN=0; shift ;;
    --quiet) DEBUG=0; QUIET=1; shift ;;
    --debug) DEBUG=1; shift ;;
    --) shift; (($# <= 1)) || die 'informe apenas um diretório'; (($# == 1)) && ROOT=$1; break ;;
    -*) die "opção desconhecida: $1" ;;
    *) [[ $ROOT == '.' ]] || die 'informe apenas um diretório'; ROOT=$1; shift ;;
  esac
done

[[ $TOKENS =~ ^[0-9]+$ ]] && (( TOKENS >= 1000 )) || die ' --tokens precisa ser um inteiro >= 1000'
[[ $SAFETY_PERCENT =~ ^[0-9]+$ ]] && (( SAFETY_PERCENT >= 5 && SAFETY_PERCENT <= 50 )) || die '--margem precisa ficar entre 5 e 50'
case "$MODE" in seguro|compacto|sem-minificar) ;; *) die "modo inválido: $MODE" ;; esac

# Sem argumentos, oferece um fluxo interativo curto; em automação usa padrões.
if [[ $# -eq 0 && -t 0 ]] && [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  INTERACTIVE=1
  printf 'Orçamento estimado de tokens por parte [%s]: ' "$TOKENS"
  if IFS= read -r answer && [[ -n $answer ]]; then TOKENS=$answer; fi
  [[ $TOKENS =~ ^[0-9]+$ ]] && (( TOKENS >= 1000 )) || die 'orçamento inválido'
  printf 'Modo [seguro/compacto/sem-minificar] [%s]: ' "$MODE"
  if IFS= read -r answer && [[ -n $answer ]]; then MODE=$answer; fi
  case "$MODE" in seguro|compacto|sem-minificar) ;; *) die 'modo inválido' ;; esac
fi

ROOT=$(cd -- "$ROOT" 2>/dev/null && pwd -P) || die 'diretório inexistente'
[[ -d $ROOT ]] || die 'o caminho informado não é diretório'
for cmd in awk find grep sort stat sha256sum cmp fold wc mktemp cp mv rm sed; do
  command -v "$cmd" >/dev/null 2>&1 || die "ferramenta obrigatória ausente: $cmd"
done

REPO_NAME=${ROOT##*/}
[[ -n $REPO_NAME ]] || REPO_NAME='repositorio'
SAFE_NAME=$(printf '%s' "$REPO_NAME" | sed 's/[^[:alnum:]_.-]/-/g; s/--*/-/g; s/^-//; s/-$//')
[[ -n $SAFE_NAME ]] || SAFE_NAME='repositorio'
OUTDIR="$ROOT/$OUTPUT_DIR_NAME"
mkdir -p -- "$OUTDIR"
# O próprio diretório de saída nunca entra como fonte.
TMP_BASE=$(mktemp -d "${TMPDIR:-/tmp}/sangue-suga.XXXXXXXX")
STAGE="$OUTDIR/.staging-${BASHPID}-${RANDOM}"
mkdir -m 700 -- "$STAGE"
cleanup() { rm -rf -- "$TMP_BASE"; [[ -d $STAGE ]] && rm -rf -- "$STAGE"; }
trap cleanup EXIT INT TERM

# Margem adicional: limita o conteúdo de cada parte a (100-margem)% do alvo.
# Isso deixa espaço para cabeçalhos, delimitadores e variação do tokenizer.
TARGET_TOKENS=$(( TOKENS * (100 - SAFETY_PERCENT) / 100 ))
(( TARGET_TOKENS >= 500 )) || TARGET_TOKENS=500
# Estimativa deliberadamente simples, determinística e local: 1 token / 4 chars.
chars_of_file() { wc -m < "$1" | tr -d '[:space:]'; }
tokens_of_file() { local c; c=$(chars_of_file "$1"); printf '%s' $(((c + 3) / 4)); }

is_source_path() {
  local p=$1 b=${1##*/} ext
  case "$b" in
    Dockerfile|Containerfile|Makefile|GNUmakefile|Rakefile|Gemfile|Podfile|Vagrantfile|Procfile|Justfile|Taskfile.yml|Taskfile.yaml|CMakeLists.txt|Brewfile|Fastfile|BUILD|WORKSPACE|BUILD.bazel|WORKSPACE.bazel|.env|.env.*) return 0 ;;
  esac
  if [[ $b == *.* ]]; then ext=${b##*.}; ext=${ext,,}; else ext=''; fi
  case "$ext" in
    c|h|cc|cp|cpp|cxx|hh|hpp|hxx|ipp|ixx|m|mm|cs|java|kt|kts|scala|groovy|clj|cljs|cljc|edn|fs|fsx|fsi|vb|dart|go|rs|swift|zig|nim|v|sv|vhd|vhdl|hs|lhs|elm|ex|exs|erl|hrl|lua|pl|pm|t|php|php3|php4|php5|phtml|py|pyw|rb|rake|js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|sol|move|sql|graphql|gql|proto|html|htm|xhtml|xml|xsd|xsl|xslt|svg|css|scss|sass|less|styl|nix|sh|bash|zsh|fish|ksh|csh|ps1|psm1|bat|cmd|asm|s|S|inc) return 0 ;;
  esac
  # Híbrido: shebang, bit executável e alguns padrões de sintaxe.
  local first
  IFS= read -r first < "$ROOT/$p" || true
  [[ $first == '#!'* ]] && return 0
  [[ -x "$ROOT/$p" && $b != *.* ]] && return 0
  grep -Iq . -- "$ROOT/$p" 2>/dev/null || return 1
  grep -Eq '(^|[[:space:]])(function|class|def|import|export|package|namespace|fn|func|const|let|var)[[:space:]]|^[[:space:]]*#include[[:space:]]|^[[:space:]]*<\?php' -- "$ROOT/$p" 2>/dev/null && return 0
  return 1
}

excluded_path() {
  local p=$1
  [[ $p == "$OUTPUT_DIR_NAME" || $p == "$OUTPUT_DIR_NAME"/* ]] && return 0
  [[ $p == .git/* || $p == */.git/* ]] && return 0
  case "/$p/" in
    */node_modules/*|*/vendor/bundle/*|*/vendor/cache/*|*/dist/*|*/build/*|*/target/*|*/coverage/*|*/.next/*|*/.nuxt/*|*/out/*|*/tmp/*|*/log/*|*/.cache/*|*/.turbo/*|*/.parcel-cache/*|*/__pycache__/*|*/.venv/*|*/venv/*|*/Pods/*|*/DerivedData/*|*/.idea/*|*/.gradle/*|*/.terraform/*) return 0;;
  esac
  (( INCLUDE_HIDDEN )) || [[ ! $p =~ (^|/)\.[^/]+ ]] || return 0
  [[ $p =~ (^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock)$ ]] && return 0
  [[ $p =~ \.(min|bundle)\.(js|css)$ || $p =~ \.(map|sum|cache)$ ]] && return 0
  return 1
}

CANDIDATE_FILE="$TMP_BASE/candidates.nul"
VALID_FILE="$TMP_BASE/valid.nul"
DISCOVERY_REPORT="$TMP_BASE/discovery-report.txt"
: > "$DISCOVERY_REPORT"
: > "$CANDIDATE_FILE"; : > "$VALID_FILE"
GIT_MODE=0
TRACKED_FILE="$TMP_BASE/tracked.nul"
: > "$TRACKED_FILE"
declare -A TRACKED_PATHS=()
if (( ! NO_GIT )) && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_MODE=1
  log 'Descoberta por Git: rastreados + não rastreados não ignorados.'
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard > "$CANDIDATE_FILE" || warn 'git ls-files falhou; a lista pode estar incompleta'
  git -C "$ROOT" ls-files -z --cached > "$TRACKED_FILE" || true
  while IFS= read -r -d '' tracked; do TRACKED_PATHS["$tracked"]=1; done < "$TRACKED_FILE"
  # Git não enumera os filhos de um link simbólico para diretório. Descobre
  # esses filhos pelo caminho do link, inclusive quando o destino é externo.
  while IFS= read -r -d '' link; do
    [[ -d $link ]] || continue
    link_rel=${link#"$ROOT"/}
    if [[ -z ${TRACKED_PATHS[$link_rel]+x} ]] && git -C "$ROOT" check-ignore -q -- "$link_rel" 2>/dev/null; then
      log "Link simbólico ignorado pelo Git: $link_rel"; continue
    fi
    find -L "$link" -type f -print0 >> "$CANDIDATE_FILE" 2>> "$TMP_BASE/find-errors.log" || true
  done < <(find "$ROOT" -type l -print0 2>/dev/null)
else
  log 'Descoberta por find -L: links simbólicos serão seguidos, inclusive externos.'
  find -L "$ROOT" -type f -print0 > "$CANDIDATE_FILE" 2> "$TMP_BASE/find-errors.log" || warn 'find encontrou erros; consulte o relatório'
fi

# Normalize candidate names; find/Git may provide paths relative to ROOT.
while IFS= read -r -d '' candidate; do
  if [[ $candidate == "$ROOT"/* ]]; then rel=${candidate#"$ROOT"/}; else rel=$candidate; fi
  [[ -n $rel && $rel != /* ]] || continue
  ((CANDIDATES+=1))
  if (( GIT_MODE )) && [[ -z ${TRACKED_PATHS[$rel]+x} ]] && git -C "$ROOT" check-ignore -q -- "$rel" 2>/dev/null; then
    ((SKIPPED+=1)); printf 'IGNORADO: %s | motivo=Git ignore\n' "$rel" >> "$DISCOVERY_REPORT"; continue
  fi
  excluded_path "$rel" && { ((SKIPPED+=1)); printf 'IGNORADO: %s | motivo=regra de exclusão\n' "$rel" >> "$DISCOVERY_REPORT"; continue; }
  full="$ROOT/$rel"
  [[ -f $full && -r $full ]] || { ((SKIPPED+=1)); log "Não é arquivo regular/legível: $rel"; continue; }
  if ! grep -Iq . -- "$full" 2>/dev/null && [[ -s $full ]]; then
    ((BINARIES+=1)); ((SKIPPED+=1)); bsize=$(stat -c '%s' -- "$full" 2>/dev/null || echo '?'); log "Binário excluído: $rel ($bsize bytes)"; printf 'BINÁRIO_EXCLUÍDO: %s | bytes=%s | motivo=conteúdo não textual\n' "$rel" "$bsize" >> "$DISCOVERY_REPORT"; continue
  fi
  is_source_path "$rel" || { ((SKIPPED+=1)); log "Não classificado como código: $rel"; printf 'IGNORADO: %s | motivo=não classificado como código\n' "$rel" >> "$DISCOVERY_REPORT"; continue; }
  printf '%s\0' "$rel" >> "$VALID_FILE"
done < "$CANDIDATE_FILE"

# Sort NUL-safe. LC_ALL=C ensures deterministic bytewise ordering.
LC_ALL=C sort -zu "$VALID_FILE" -o "$VALID_FILE"
mapfile -d '' FILES < "$VALID_FILE"
SELECTED=${#FILES[@]}
(( SELECTED > 0 )) || die 'Nenhum arquivo de código elegível encontrado. Use --debug para detalhes.'
info "Candidatos: $CANDIDATES | código elegível: $SELECTED | binários: $BINARIES | ignorados: $SKIPPED"
info "Orçamento: $TOKENS tokens estimados/parte | margem: ${SAFETY_PERCENT}% | alvo interno: $TARGET_TOKENS"

# Comment stripper implemented in awk, without Perl/Node/Python dependencies.
# It is intentionally conservative: it strips common line/block comments only
# for recognized syntaxes; directives that can affect builds are preserved.
FILTER="$TMP_BASE/filter.awk"
cat > "$FILTER" <<'AWK'
function is_c(e) { return e ~ /^(c|h|cc|cp|cpp|cxx|hh|hpp|hxx|ipp|ixx|cs|java|kt|kts|scala|go|rs|swift|zig|dart|v|sv|sol|js|jsx|mjs|cjs|ts|tsx|mts|cts|php|css|scss|sass|less|sql|proto|graphql|gql)$/ }
function is_hash(e) { return e ~ /^(py|pyw|rb|rake|pl|pm|t|lua|r|sh|bash|zsh|fish|ksh|ps1|psm1|nim|ex|exs|yaml|yml|toml|nix|tf|hcl)$/ }
function is_html(e) { return e ~ /^(html|htm|xhtml|xml|xsd|xsl|xslt|vue|svelte|astro|svg)$/ }
function directive(s,e) {
  if (e ~ /^(c|h|cc|cpp|cxx|hpp)$/ && s ~ /^[[:space:]]*#[[:space:]]*(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error|line)/) return 1
  if (e == "go" && s ~ /^[[:space:]]*\/\/[[:space:]]*go:/) return 1
  if (e == "go" && s ~ /^[[:space:]]*\/\/[[:space:]]*\+build/) return 1
  if (e == "rb" && s ~ /^[[:space:]]*#.*(frozen_string_literal:|coding:|encoding:|typed:|rubocop:|standard:)/) return 1
  if (e == "rust" && s ~ /^[[:space:]]*#\[/) return 1
  if (e == "py" && s ~ /^[[:space:]]*#.*(coding[:=]|type:[[:space:]]*ignore|noqa|mypy:|ruff:)/) return 1
  if (e == "sh" && s ~ /^#!/) return 1
  return 0
}
function cleanline(s,e,    out,i,c,n,q,esc,st) {
  if (directive(s,e)) return s
  out=""; q=""; esc=0; st=0
  for (i=1;i<=length(s);i++) {
    c=substr(s,i,1); n=substr(s,i+1,1)
    if (block==1) { if (c=="*" && n=="/") { block=0; i++ }; continue }
    if (htmlblock==1) { if (substr(s,i,3)=="-->") { htmlblock=0; i+=2 }; continue }
    if (q!="") { out=out c; if (esc) esc=0; else if (c=="\\") esc=1; else if (c==q) q=""; continue }
    if (c=="\"" || c=="'" || c=="`") { q=c; out=out c; continue }
    if (is_html(e) && substr(s,i,4)=="<!--") { htmlblock=1; i+=3; continue }
    if (is_c(e) && c=="/" && n=="*") { block=1; i++; continue }
    if (is_c(e) && c=="/" && n=="/") break
    if (is_hash(e) && c=="#") {
      # Ruby interpolation and shebang are preserved conservatively.
      if (e=="rb" && substr(s,i,2)=="#{") { out=out c; continue }
      if (i==1 && substr(s,1,2)=="#!") { out=out substr(s,i); break }
      break
    }
    if (e=="lua" && c=="-" && n=="-") break
    if (e=="sql" && c=="-" && n=="-") break
    out=out c
  }
  return out
}
BEGIN { block=0; htmlblock=0 }
{
  line=$0; e=tolower(ext)
  if (mode != "compacto") { print line; next }
  if (!(is_c(e) || is_hash(e) || is_html(e))) { print line; next }
  print cleanline(line,e)
}
AWK

# Staging data. Every unique original byte sequence gets a canonical block;
# duplicate paths become explicit references to that block.
BLOCKS="$TMP_BASE/blocks"
mkdir -p -- "$BLOCKS"
declare -A HASH_PATH=()
declare -A HASH_FILE=()
declare -A SNAPSHOT_HASH=()
declare -A FILE_FRAG_COUNT=()
REPORT="$STAGE/relatorio-${SAFE_NAME}.txt"
: > "$REPORT"
printf 'SANGUE-SUGA %s\nRepositório: %s\nOrçamento configurado: %s tokens/parte\nMargem aplicada: %s%%\nModo: %s\n\n' "$VERSION" "$ROOT" "$TOKENS" "$SAFETY_PERCENT" "$MODE" >> "$REPORT"
cat -- "$DISCOVERY_REPORT" >> "$REPORT"
[[ ! -s "$TMP_BASE/find-errors.log" ]] || { printf '\nERROS_DA_BUSCA\n' >> "$REPORT"; cat -- "$TMP_BASE/find-errors.log" >> "$REPORT"; }

# A content block is split into bounded fragments by line. If one line alone
# is oversized, fold breaks it into smaller textual segments and marks it as a
# fragment. The source bytes are never silently dropped.
FRAG_DIR="$TMP_BASE/fragments"; mkdir -p -- "$FRAG_DIR"
FRAG_INDEX="$TMP_BASE/fragments.tsv"; : > "$FRAG_INDEX"
FRAG_ID=0

make_fragments() {
  local rel=$1 src=$2 canonical=$3 hash=$4 processed="$TMP_BASE/processed"
  local line linefile="$TMP_BASE/line.tmp" cur="$TMP_BASE/current-fragment" curtokens=0 linetokens=0 chunk_idx=0 folded="$TMP_BASE/folded.tmp"
  local maxchars=$(( TARGET_TOKENS * 3 ))
  (( maxchars >= 1500 )) || maxchars=1500
  if [[ $MODE == 'compacto' ]]; then
    local ext=${rel##*.}; ext=${ext,,} unsafe_syntax=0
    # O scanner não é um parser completo. Em construções multilinha ambíguas,
    # preserva o arquivo inteiro em vez de remover texto que possa ser código.
    case "$ext" in
      py|pyw)
        if grep -Fq $'\"\"\"' -- "$src" || grep -Fq "'''" -- "$src"; then unsafe_syntax=1; fi ;;
      rb|rake)
        if grep -Fq '<<' -- "$src"; then unsafe_syntax=1; fi ;;
      c|h|cc|cpp|cxx|hpp|hxx)
        if grep -Eq '(^|[^[:alnum:]_])([uUL]|u8)?R\"' -- "$src"; then unsafe_syntax=1; fi ;;
      js|jsx|mjs|cjs|ts|tsx|mts|cts|go)
        if grep -Fq '`' -- "$src"; then unsafe_syntax=1; fi ;;
      lua)
        if grep -Eq '\-\-[=]*\[' -- "$src"; then unsafe_syntax=1; fi ;;
    esac
    if (( unsafe_syntax )); then
      warn "Sintaxe multilinha ambígua; comentários preservados para segurança: $rel"
      printf 'COMENTÁRIOS_PRESERVADOS: %s | motivo=sintaxe multilinha não analisada com segurança\n' "$rel" >> "$REPORT"
      cp -- "$src" "$processed"
    elif ! awk -v mode='compacto' -v ext="$ext" -f "$FILTER" "$src" > "$processed"; then
      warn "Falha na transformação, conteúdo original preservado: $rel"
      cp -- "$src" "$processed"; ((FAILED+=1))
    fi
  else
    cp -- "$src" "$processed" || return 1
  fi
  local totalchars; totalchars=$(chars_of_file "$processed")
  ((INPUT_CHARS+= $(chars_of_file "$src")))
  printf 'ARQUIVO: %s | bytes=%s | chars=%s | sha256=%s\n' "$rel" "$(stat -c '%s' -- "$src")" "$(chars_of_file "$src")" "$hash" >> "$REPORT"
  : > "$cur"; curtokens=0; chunk_idx=0
  # Read line-by-line to avoid loading the entire file into shell memory.
  while IFS= read -r line || [[ -n $line ]]; do
    printf '%s\n' "$line" > "$linefile"
    linetokens=$(tokens_of_file "$linefile")
    if (( linetokens > TARGET_TOKENS )); then
      # Flush accumulated lines before fragmenting the oversized line.
      if [[ -s $cur ]]; then
        ((FRAG_ID+=1)); chunk_idx=$((chunk_idx+1)); local outfrag="$FRAG_DIR/frag-$(printf '%07d' "$FRAG_ID")"
        cp -- "$cur" "$outfrag"; printf '%s\t%s\t%s\t%s\t%s\n' "$outfrag" "$rel" "$canonical" "$chunk_idx" 'fragment' >> "$FRAG_INDEX"
        : > "$cur"; curtokens=0
      fi
      fold -w "$maxchars" "$linefile" > "$folded"
      while IFS= read -r foldedline || [[ -n $foldedline ]]; do
        printf '%s\n' "$foldedline" > "$linefile"
        if (( curtokens > 0 && curtokens + $(tokens_of_file "$linefile") > TARGET_TOKENS )); then
          ((FRAG_ID+=1)); chunk_idx=$((chunk_idx+1)); outfrag="$FRAG_DIR/frag-$(printf '%07d' "$FRAG_ID")"
          cp -- "$cur" "$outfrag"; printf '%s\t%s\t%s\t%s\t%s\n' "$outfrag" "$rel" "$canonical" "$chunk_idx" 'fragmento-linha' >> "$FRAG_INDEX"
          : > "$cur"; curtokens=0
        fi
        cat -- "$linefile" >> "$cur"; curtokens=$((curtokens + $(tokens_of_file "$linefile")))
      done < "$folded"
    else
      if (( curtokens > 0 && curtokens + linetokens > TARGET_TOKENS )); then
        ((FRAG_ID+=1)); chunk_idx=$((chunk_idx+1)); outfrag="$FRAG_DIR/frag-$(printf '%07d' "$FRAG_ID")"
        cp -- "$cur" "$outfrag"; printf '%s\t%s\t%s\t%s\t%s\n' "$outfrag" "$rel" "$canonical" "$chunk_idx" 'fragmento' >> "$FRAG_INDEX"
        : > "$cur"; curtokens=0
      fi
      cat -- "$linefile" >> "$cur"; curtokens=$((curtokens + linetokens))
    fi
  done < "$processed"
  if [[ -s $cur || $chunk_idx -eq 0 ]]; then
    ((FRAG_ID+=1)); chunk_idx=$((chunk_idx+1)); outfrag="$FRAG_DIR/frag-$(printf '%07d' "$FRAG_ID")"
    cp -- "$cur" "$outfrag"; printf '%s\t%s\t%s\t%s\t%s\n' "$outfrag" "$rel" "$canonical" "$chunk_idx" 'fragmento' >> "$FRAG_INDEX"
  fi
  FILE_FRAG_COUNT["$rel"]=$chunk_idx
  printf '  fragmentos=%s\n' "$chunk_idx" >> "$REPORT"
}

# Candidate processing and exact-byte duplicate detection.
for rel in "${FILES[@]}"; do
  full="$ROOT/$rel"
  if [[ ! -f $full || ! -r $full ]]; then
    ((FAILED+=1)); warn "Arquivo desapareceu ou ficou ilegível: $rel"; printf 'FALHA: %s (sumiu/ilegível)\n' "$rel" >> "$REPORT"; continue
  fi
  ((PROCESSED+=1))
  if (( PROCESSED == 1 || PROCESSED % 25 == 0 || PROCESSED == SELECTED )); then
    info "Processando $PROCESSED/$SELECTED ($(( PROCESSED * 100 / SELECTED ))%)"
  fi
  size=$(stat -c '%s' -- "$full" 2>/dev/null || echo 0)
  if (( size > 0 )) && ! grep -Iq . -- "$full" 2>/dev/null; then
    ((BINARIES+=1)); ((SKIPPED+=1)); printf 'BINÁRIO: %s | bytes=%s\n' "$rel" "$size" >> "$REPORT"; continue
  fi
  hash=$(sha256sum -- "$full" | awk '{print $1}')
  SNAPSHOT_HASH["$rel"]=$hash
  if [[ -n ${HASH_FILE[$hash]+x} ]] && cmp -s -- "$full" "${HASH_FILE[$hash]}"; then
    ((DUPLICATES+=1))
    canonical=${HASH_PATH[$hash]}
    printf 'DUPLICATA_EXATA: %s -> %s (sha256=%s)\n' "$rel" "$canonical" "$hash" >> "$REPORT"
    # Explicit reference block consumes little context and preserves path mapping.
    ref="$FRAG_DIR/frag-$(printf '%07d' "$((FRAG_ID+1))")"
    ((FRAG_ID+=1))
    FILE_FRAG_COUNT["$rel"]=1
    printf '[{arquivo:%s}]\n[conteudo-duplicado: ver %s; sha256=%s]\n[{fim-arquivo:%s}]\n' "$rel" "$canonical" "$hash" "$rel" > "$ref"
    printf '%s\t%s\t%s\t%s\t%s\n' "$ref" "$rel" "$canonical" '1' 'referencia-duplicata' >> "$FRAG_INDEX"
    continue
  fi
  canon="$rel"
  HASH_PATH[$hash]=$canon
  HASH_FILE[$hash]="$TMP_BASE/original-$(printf '%07d' "$PROCESSED")"
  cp -- "$full" "${HASH_FILE[$hash]}" || { ((FAILED+=1)); warn "Falha ao copiar para comparação: $rel"; continue; }
  make_fragments "$rel" "$full" "$canon" "$hash" || { ((FAILED+=1)); warn "Falha ao fragmentar: $rel"; continue; }
done

# Assemble bounded output parts. The per-part estimate includes headers and
# markers; fragments have already been capped below the effective target.
PART_TMP="$TMP_BASE/parts"; mkdir -p -- "$PART_TMP"
part_num=1; part_file="$PART_TMP/part-$(printf '%03d' "$part_num").txt"; : > "$part_file"
part_tokens=0
write_header() {
  printf 'SANGUE-SUGA %s | REPOSITÓRIO: %s | PARTE %03d\n' "$VERSION" "$REPO_NAME" "$1" >> "$2"
  printf 'Orçamento: %s tokens estimados | alvo conservador: %s | modo: %s\n' "$TOKENS" "$TARGET_TOKENS" "$MODE" >> "$2"
  printf 'Aviso: contagem aproximada, não equivale a tokenizer específico.\n\n' >> "$2"
}
write_header "$part_num" "$part_file"
part_tokens=$(tokens_of_file "$part_file")

while IFS=$'\t' read -r frag rel canonical fragno fragtype; do
  [[ -f $frag ]] || continue
  block="$TMP_BASE/block.tmp"
  if [[ $fragtype == 'referencia-duplicata' ]]; then
    cat -- "$frag" > "$block"
  else
    total_fragments=${FILE_FRAG_COUNT[$rel]:-1}
    canonical_hash=${SNAPSHOT_HASH[$canonical]:-desconhecido}
    if (( total_fragments == 1 )); then
      printf '[{arquivo:%s; sha256=%s}]\n' "$rel" "$canonical_hash" > "$block"
    else
      printf '[{arquivo:%s; parte=%s/%s; continua=%s; sha256=%s}]\n' "$rel" "$fragno" "$total_fragments" "$([[ $fragno == 1 ]] && echo nao || echo sim)" "$canonical_hash" > "$block"
    fi
    cat -- "$frag" >> "$block"
    if (( total_fragments == 1 )); then
      printf '\n[{fim-arquivo:%s}]\n\n' "$rel" >> "$block"
    else
      printf '\n[{fim-fragmento:%s; parte=%s/%s}]\n\n' "$rel" "$fragno" "$total_fragments" >> "$block"
    fi
  fi
  block_tokens=$(tokens_of_file "$block")
  if (( part_tokens > 0 && part_tokens + block_tokens > TOKENS )); then
    ((part_num+=1)); part_file="$PART_TMP/part-$(printf '%03d' "$part_num").txt"; : > "$part_file"
    write_header "$part_num" "$part_file"; part_tokens=$(tokens_of_file "$part_file")
  fi
  # A pathological single block may exceed the configured budget due to
  # headers/markers. Never silently discard it; record it loudly.
  if (( block_tokens + part_tokens > TOKENS )); then
    warn "Bloco ainda excede orçamento estimado: $rel (~$block_tokens tokens). Consulte o relatório."
    printf 'BLOCO_ACIMA_DO_ORCAMENTO: %s tokens=%s\n' "$rel" "$block_tokens" >> "$REPORT"
  fi
  cat -- "$block" >> "$part_file"
  part_tokens=$((part_tokens + block_tokens))
done < "$FRAG_INDEX"

PARTS=$part_num
# Add total-part marker by rebuilding each header in staging output.
for ((i=1; i<=PARTS; i++)); do
  p="$PART_TMP/part-$(printf '%03d' "$i").txt"
  tmp="$p.new"
  { printf 'SANGUE-SUGA %s | REPOSITÓRIO: %s | PARTE %03d/%03d\n' "$VERSION" "$REPO_NAME" "$i" "$PARTS"; tail -n +2 "$p"; } > "$tmp"
  mv -- "$tmp" "$p"
done

# Detailed report and status.
printf '\nRESUMO\nCandidatos: %s\nElegíveis: %s\nProcessados: %s\nIgnorados: %s\nBinários: %s\nDuplicatas exatas: %s\nFalhas: %s\nPartes: %s\n' \
  "$CANDIDATES" "$SELECTED" "$PROCESSED" "$SKIPPED" "$BINARIES" "$DUPLICATES" "$FAILED" "$PARTS" >> "$REPORT"

# Recheck changed files; report only, as requested, and keep the generated work.
CHANGED=0
while IFS= read -r -d '' rel; do
  [[ -f "$ROOT/$rel" ]] || { ((CHANGED+=1)); printf 'ALTERADO/DESAPARECIDO: %s\n' "$rel" >> "$REPORT"; continue; }
  oldhash=${SNAPSHOT_HASH[$rel]:-}
  [[ -n $oldhash ]] || continue
  newhash=$(sha256sum -- "$ROOT/$rel" | awk '{print $1}')
  if [[ $oldhash != "$newhash" ]]; then ((CHANGED+=1)); printf 'ALTERADO_DURANTE_EXECUCAO: %s\n' "$rel" >> "$REPORT"; fi
done < "$VALID_FILE"
(( CHANGED == 0 )) || warn "$CHANGED arquivo(s) mudaram ou desapareceram durante a execução; pacote mantido e relatório marcado como potencialmente inconsistente."

# Publish as a staged generation. Keep previous outputs until all new files exist.
if (( PARTS == 1 )); then
  cp -- "$PART_TMP/part-001.txt" "$STAGE/${SAFE_NAME}.txt"
else
  for ((i=1; i<=PARTS; i++)); do cp -- "$PART_TMP/part-$(printf '%03d' "$i").txt" "$STAGE/${SAFE_NAME}-parte$(printf '%03d' "$i").txt"; done
fi
# O relatório já foi escrito diretamente dentro do diretório temporário de staging.

# Verify each staged text part is readable and nonempty before replacing output.
for f in "$STAGE"/*.txt; do
  [[ -s $f ]] || die "validação da saída falhou: $f"
done

# Backup the old generation for rollback if a move fails.
BACKUP="$OUTDIR/.backup-${BASHPID}-${RANDOM}"; mkdir -m 700 -- "$BACKUP"
shopt -s nullglob
oldfiles=("$OUTDIR/${SAFE_NAME}.txt" "$OUTDIR/${SAFE_NAME}-parte"*.txt "$OUTDIR/relatorio-${SAFE_NAME}.txt")
for f in "${oldfiles[@]}"; do [[ -f $f ]] && mv -- "$f" "$BACKUP/"; done
publish_ok=1
for f in "$STAGE"/*.txt; do
  if ! mv -- "$f" "$OUTDIR/"; then publish_ok=0; break; fi
done
if (( ! publish_ok )); then
  warn 'Falha ao publicar; tentando restaurar a geração anterior.'
  rm -f -- "$OUTDIR/${SAFE_NAME}.txt" "$OUTDIR/${SAFE_NAME}-parte"*.txt "$OUTDIR/relatorio-${SAFE_NAME}.txt"
  for f in "$BACKUP"/*; do [[ -e $f ]] && mv -- "$f" "$OUTDIR/"; done
  die 'publicação falhou; geração anterior restaurada quando possível'
fi
rm -rf -- "$BACKUP"

# Output stats based on actual published files.
for ((i=1; i<=PARTS; i++)); do
  if (( PARTS == 1 )); then f="$OUTDIR/${SAFE_NAME}.txt"; else f="$OUTDIR/${SAFE_NAME}-parte$(printf '%03d' "$i").txt"; fi
  [[ -f $f ]] || continue
  c=$(chars_of_file "$f"); OUTPUT_CHARS=$((OUTPUT_CHARS + c))
  est=$(((c + 3) / 4))
  if (( est > TOKENS )); then warn "A parte $(basename -- "$f") estima $est tokens, acima do orçamento $TOKENS. A estimativa é aproximada; verifique o relatório."; fi
  info "Gerado: $f | $(stat -c '%s bytes' -- "$f") | ~${est} tokens"
done
info "Relatório: $OUTDIR/relatorio-${SAFE_NAME}.txt"
printf '\n========== RESUMO FINAL ==========\n'
printf 'Repositório:            %s\n' "$ROOT"
printf 'Arquivos candidatos:    %d\n' "$CANDIDATES"
printf 'Arquivos elegíveis:     %d\n' "$SELECTED"
printf 'Arquivos processados:   %d\n' "$PROCESSED"
printf 'Binários excluídos:     %d\n' "$BINARIES"
printf 'Duplicatas exatas:      %d\n' "$DUPLICATES"
printf 'Ignorados:              %d\n' "$SKIPPED"
printf 'Falhas:                 %d\n' "$FAILED"
printf 'Partes geradas:         %d\n' "$PARTS"
printf 'Arquivos alterados:     %d\n' "$CHANGED"
printf 'Tokens configurados:    %d por parte (estimativa)\n' "$TOKENS"
printf 'Saída:                  %s\n' "$OUTDIR"
if (( FAILED > 0 || CHANGED > 0 )); then printf 'Status: PARCIAL/POTENCIALMENTE INCONSISTENTE\n'; else printf 'Status: CONCLUÍDO\n'; fi
printf '==================================\n'
