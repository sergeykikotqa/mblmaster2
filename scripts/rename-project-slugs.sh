#!/usr/bin/env bash
set -euo pipefail

declare -A MAP=(
  ["kuhnya-irkutsk-baykalskaya"]="kuhnya-baykalskaya"
  ["kuhnya-irkutsk-grafitovaya-dalnevostochnaya"]="kuhnya-grafitovaya"
  ["kuhnya-irkutsk-uglovaya-piskunova"]="kuhnya-piskunova"
  ["kuhnya-irkutsk-belaya-uglovaya-trilissera"]="kuhnya-trilissera"
  ["kuhnya-irkutsk-uglovaya-krasnokazachya"]="kuhnya-krasnokazachya"
  ["kuhnya-irkutsk-belaya-uglovaya-baykalskiy-trakt"]="kuhnya-baykalskiy-trakt"
  ["kuhnya-irkutsk-biryuzovaya-uglovaya-bogdana"]="kuhnya-bogdana"
  ["kuhnya-irkutsk-belaya-s-barom-dzerzhinskogo"]="kuhnya-dzerzhinskogo"
  ["shkaf-irkutsk-rabochaya-zona-deputatskaya"]="shkaf-deputatskaya"
  ["kuhnya-irkutsk-verkhnyaya-naberezhnaya"]="kuhnya-verkhnyaya-naberezhnaya"
)

if ! command -v perl >/dev/null 2>&1; then
  echo "perl is required for in-place replacements." >&2
  exit 1
fi

use_git=false
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  use_git=true
fi

move_item() {
  local from="$1"
  local to="$2"
  if [ ! -e "$from" ]; then
    return 0
  fi
  if [ "$use_git" = true ]; then
    git mv "$from" "$to"
  else
    mv "$from" "$to"
  fi
}

for old in "${!MAP[@]}"; do
  new="${MAP[$old]}"

  move_item "src/content/projects/${old}.md" "src/content/projects/${new}.md"
  move_item "src/content/projects/${old}.mdx" "src/content/projects/${new}.mdx"
  move_item "src/assets/images/projects/${old}" "src/assets/images/projects/${new}"

  perl -pi -e "s/${old}/${new}/g" src/content/projects/*.md src/content/projects/*.mdx data/local-city-blocks.json 2>/dev/null || true
done

echo "Slug rename pass completed."
