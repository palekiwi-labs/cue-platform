-- Markdown heading navigation, ported from the host's nvim 0.11 config to
-- native Neovim 0.12 treesitter APIs. The old version depended on the legacy
-- nvim-treesitter Lua API (`require("nvim-treesitter.ts_utils").goto_node` and
-- the `nvim_treesitter#foldexpr()` autoload function), both of which are gone
-- in the rewritten nvim-treesitter that nvf ships. Everything below uses only
-- the built-in `vim.treesitter` runtime, so there is no plugin dependency.

--- Parsed once at load. `atx_heading` is the `# Heading` node in the markdown
--- grammar. Kept equivalent to the host behavior (setext headings excluded).
local query = vim.treesitter.query.parse("markdown", "(atx_heading) @heading")

--- Return the 0-based start row of every atx_heading in the buffer, ascending.
---@param bufnr integer
---@return integer[]
local function heading_rows(bufnr)
  local parser = assert(vim.treesitter.get_parser(bufnr, "markdown"))
  local root = parser:parse()[1]:root()
  local rows = {}
  for _, node in query:iter_captures(root, bufnr, 0, -1) do
    rows[#rows + 1] = (node:start())
  end
  return rows
end

--- Jump to the count-th heading in the given direction, then scroll it to the
--- top of the window (`zt`). No-op if there is no such heading.
---@param direction "next" | "prev"
local function jump(direction)
  local count = vim.v.count == 0 and 1 or vim.v.count
  local cur = vim.fn.line(".") - 1 -- current row, 0-based
  local rows = heading_rows(0)

  -- `vim.iter` chains make the directional lookup declarative:
  --   next -> first heading strictly after cursor
  --   prev -> reverse, then first heading strictly before cursor
  local target
  if direction == "next" then
    target = vim.iter(rows):filter(function(r) return r > cur end):nth(count)
  else
    target = vim.iter(rows):rev():filter(function(r) return r < cur end):nth(count)
  end

  if target then
    vim.api.nvim_win_set_cursor(0, { target + 1, 0 })
    vim.cmd("normal! zt")
  end
end

-- Hard-wrap markdown prose at 80 columns.
vim.opt_local.textwidth = 80

-- Hide line numbers in markdown files.
vim.opt_local.number = false
vim.opt_local.relativenumber = false

-- Repurpose `gc` (Comment.nvim) as a blockquote toggle: prefix lines with "> ".
-- Markdown's stock commentstring is "<!-- %s -->", which is near-useless in
-- prose; blockquotes are far more common. Comment.nvim falls back to
-- `commentstring` for markdown (it has no built-in ft entry), so this is enough.
vim.bo.commentstring = "> %s"

-- Per-markdown treesitter folding using the native foldexpr (the replacement
-- for the removed `nvim_treesitter#foldexpr()`). foldlevel 99 keeps the file
-- open by default, matching the host.
vim.opt_local.foldmethod = "expr"
vim.opt_local.foldexpr = "v:lua.vim.treesitter.foldexpr()"
vim.opt_local.foldlevel = 99

-- `desc` is picked up by which-key-style plugins; `silent` keeps the jump quiet.
vim.keymap.set({ "n", "v" }, "<C-Down>", function() jump("next") end,
  { silent = true, buffer = true, desc = "Markdown: next heading" })
vim.keymap.set({ "n", "v" }, "<C-Up>", function() jump("prev") end,
  { silent = true, buffer = true, desc = "Markdown: previous heading" })

-- Manual structural formatting via conform + mdformat (",md"). mdformat
-- defaults to --wrap=keep, so this only normalizes document structure (blank
-- lines around headings/lists, list markers, trailing whitespace) and leaves
-- prose wrapping to the `gw` operator below. Scoped to markdown so the keymap
-- only exists where a formatter is actually configured. Bound to <leader>md
-- (not <leader>ff) so it shares no prefix with <leader>f (",f", the combined
-- wrap+format binding) -- otherwise both ,f and ,ff mapped would impose a
-- timeoutlen delay on the common ,f path while Neovim waits to disambiguate.
vim.keymap.set("n", "<leader>md", function()
  require("conform").format({ bufnr = 0 })
end, { silent = true, buffer = true, desc = "Markdown: format buffer (mdformat)" })

-- Intelligent protected line-wrapping for gW.
-- Since gw ignores formatexpr and formatprg, we remap gW to a custom operator.
_G.__markdown_gw_format = function(motion_type)
  local start_line = vim.api.nvim_buf_get_mark(0, "[")[1]
  local end_line = vim.api.nvim_buf_get_mark(0, "]")[1]

  if start_line == 0 or end_line == 0 then
    return
  end

  local parser_ok, parser = pcall(vim.treesitter.get_parser, 0, "markdown")
  if not parser_ok or not parser then
    -- Fallback: standard gw
    local count = end_line - start_line
    local saved_view = vim.fn.winsaveview()
    vim.api.nvim_win_set_cursor(0, { start_line, 0 })
    if count == 0 then
      vim.cmd("normal! gww")
    else
      vim.cmd("normal! " .. count .. "gwj")
    end
    vim.fn.winrestview(saved_view)
    return
  end

  local tree = parser:parse(true)[1]
  local root = tree:root()
  -- Frontmatter ("minus_metadata" = YAML `---`, "plus_metadata" = TOML `+++`)
  -- is protected too: the grammar anchors both to the document start, so a
  -- mid-document `---` (thematic break / setext underline) can never match.
  -- Without this, gw joins the YAML into one paragraph and rewraps it at
  -- textwidth, destroying the fences.
  local query_str = "((minus_metadata) @frontmatter) ((plus_metadata) @frontmatter) ((atx_heading) @heading) ((setext_heading) @heading) ((fenced_code_block) @code) ((pipe_table) @table)"
  local query_ok, query = pcall(vim.treesitter.query.parse, "markdown", query_str)
  if not query_ok or not query then
    -- Fallback: standard gw
    local count = end_line - start_line
    local saved_view = vim.fn.winsaveview()
    vim.api.nvim_win_set_cursor(0, { start_line, 0 })
    if count == 0 then
      vim.cmd("normal! gww")
    else
      vim.cmd("normal! " .. count .. "gwj")
    end
    vim.fn.winrestview(saved_view)
    return
  end

  local protected = {}
  for id, node in query:iter_captures(root, 0, 0, -1) do
    local srow, scol, erow, ecol = node:range()
    local last_row = erow
    if ecol == 0 and erow > srow then
      last_row = erow - 1
    end
    for r = srow, last_row do
      protected[r] = true
    end
  end

  local function is_blank(line_str)
    return line_str:match("^%s*$") ~= nil
  end

  local buffer_lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local runs = {}
  local current_run = nil

  for r = start_line - 1, end_line - 1 do
    local line_str = buffer_lines[r + 1]
    if not line_str then
      break
    end

    local is_protected = protected[r] or is_blank(line_str)
    if not is_protected then
      if not current_run then
        current_run = { start_row = r, end_row = r }
      else
        current_run.end_row = r
      end
    else
      if current_run then
        table.insert(runs, current_run)
        current_run = nil
      end
    end
  end

  if current_run then
    table.insert(runs, current_run)
  end

  local delta = 0
  local saved_view = vim.fn.winsaveview()

  for _, run in ipairs(runs) do
    local run_start_1 = run.start_row + 1 + delta
    local run_end_1 = run.end_row + 1 + delta

    local lines_before = vim.api.nvim_buf_line_count(0)

    vim.api.nvim_win_set_cursor(0, { run_start_1, 0 })

    local count = run_end_1 - run_start_1
    if count == 0 then
      vim.cmd("normal! gww")
    else
      vim.cmd("normal! " .. count .. "gwj")
    end

    local lines_after = vim.api.nvim_buf_line_count(0)
    local run_delta = lines_after - lines_before
    delta = delta + run_delta
  end

  vim.fn.winrestview(saved_view)
end

-- Buffer-local keymaps remapping gW to use our custom operator
vim.keymap.set("n", "gW", function()
  vim.go.operatorfunc = "v:lua.__markdown_gw_format"
  return "g@"
end, { expr = true, buffer = true, desc = "Markdown: protected line-wrapping" })

vim.keymap.set("x", "gW", function()
  vim.go.operatorfunc = "v:lua.__markdown_gw_format"
  return "g@"
end, { expr = true, buffer = true, desc = "Markdown: protected line-wrapping" })

vim.keymap.set("n", "gWW", function()
  vim.go.operatorfunc = "v:lua.__markdown_gw_format"
  return "g@_"
end, { expr = true, buffer = true, desc = "Markdown: protected line-wrap current line" })

vim.keymap.set("n", "gw", function()
  local saved_view = vim.fn.winsaveview()
  vim.api.nvim_buf_set_mark(0, "[", 1, 0, {})
  local last_line = vim.api.nvim_buf_line_count(0)
  vim.api.nvim_buf_set_mark(0, "]", last_line, 0, {})
  _G.__markdown_gw_format("line")
  vim.fn.winrestview(saved_view)
end, { buffer = true, desc = "Markdown: protected line-wrap entire file" })

-- Combined wrap + format on <leader>f (",f"). Runs the protected line-wrap
-- (`gw`) over the whole buffer, THEN mdformat via conform, THEN wraps pipe
-- tables to textwidth. mdformat runs in --wrap=keep mode (conform's default),
-- so it normalizes structure and re-indents list continuation lines while
-- preserving the breaks `gw` just produced -- the order is what stops mdformat
-- from unwrapping prose and stops `gw` from leaving list items un-indented.
-- The table wrap runs after mdformat so single-line tables are normalized
-- first and the wrap (which re-measures trimmed cell text) emits the canonical
-- layout; its output is fully padded, so a later mdformat pass is a no-op on
-- it. The buffer ends at the top: the point of ,f is paste-then-read.
-- Exposed on _G so headless tests can call it directly.
_G.__markdown_format_all = function()
  vim.api.nvim_buf_set_mark(0, "[", 1, 0, {})
  local last_line = vim.api.nvim_buf_line_count(0)
  vim.api.nvim_buf_set_mark(0, "]", last_line, 0, {})
  _G.__markdown_gw_format("line")
  require("conform").format({ bufnr = 0 })
  _G.__markdown_wrap_tables(1, vim.api.nvim_buf_line_count(0))
  vim.cmd("normal! gg")
end

vim.keymap.set("n", "<leader>f", _G.__markdown_format_all,
  { silent = true, buffer = true, desc = "Markdown: wrap + format buffer" })

-- Wrap GFM pipe tables to the fixed textwidth on <leader>tw (visual) and as
-- the final step of <leader>f. Port of the opentui "full" table layout behind
-- opencode's TUI tables: column widths start at the natural cell widths, then
-- either expand to fill the target width exactly (opentui
-- TextTable.ts:expandColumnWidths) or shrink by sqrt-weighted water-fill when
-- content overflows, with cells word-wrapped into their column. One
-- deliberate deviation: a column never shrinks below its longest single word
-- unless even the word minima cannot fit (then words are hard-broken), since
-- split words corrupt copied text. Output is one physical line per wrapped
-- segment, fully padded, with an equals-filled rule between logical rows
-- (the pipe-table stand-in for opencode's horizontal grid rules; see
-- tw_rule for why dashes cannot be used) and the delimiter row's alignment
-- markers preserved, padded.
--
-- This is a DISPLAY-ONLY transformation: GFM parses every physical line as a
-- separate row, so a wrapped table renders as more rows in any real markdown
-- renderer -- it exists to make pasted tables readable in the buffer.
-- Re-application is a no-op: emitted rule rows are recognized, and a table
-- already sitting exactly at the target width is treated as canonical and
-- skipped (if a wrapped table is edited so lines lose the target width, a
-- re-wrap rules between all remaining segments -- grouping is unrecoverable).
--
-- Selection semantics: every table overlapping the selection is wrapped in
-- full (a partial selection never truncates a table); prose and untouched
-- tables stay verbatim. x-mode only, and the key shares no prefix with
-- <leader>f (see the <leader>md note above). Known limitation: a table
-- indented inside a list item is replaced dedented at column 0.
local function tw_trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

--- Display width of a string (CJK- and tab-aware).
---@param s string
---@return integer
local function tw_width(s)
  return vim.fn.strdisplaywidth(s)
end

--- Split cell text into words (whitespace runs are separators).
---@param s string
---@return string[]
local function tw_words(s)
  local words = {}
  for w in s:gmatch("%S+") do
    words[#words + 1] = w
  end
  return words
end

--- Greedy word wrap at `width`; a word longer than `width` is hard-broken
--- (the opentui fallback, reachable only when word minima overflow).
---@param text string
---@param width integer
---@return string[]
local function tw_wrap(text, width)
  if width < 1 then
    return { text }
  end
  local lines, cur = {}, nil
  local function flush()
    if cur then
      lines[#lines + 1] = cur
      cur = nil
    end
  end
  for _, word in ipairs(tw_words(text)) do
    while tw_width(word) > width do
      flush()
      -- Whole UTF-8 characters via the vimscript \zs split idiom: nvim's
      -- Lua is LuaJIT (5.1), which has no Lua 5.3 `utf8` stdlib, so any
      -- use of that global is a nil-index crash at runtime.
      local chars = vim.fn.split(word, "\\zs")
      local seg = ""
      for _, ch in ipairs(chars) do
        if tw_width(seg .. ch) > width then
          break
        end
        seg = seg .. ch
      end
      if seg == "" then
        -- First char alone exceeds the column (double-width rune): emit it
        -- whole rather than corrupting UTF-8 with a byte-level cut.
        seg = chars[1]
      end
      lines[#lines + 1] = seg
      word = word:sub(#seg + 1)
    end
    if not cur then
      cur = word
    elseif tw_width(cur .. " " .. word) <= width then
      cur = cur .. " " .. word
    else
      flush()
      cur = word
    end
  end
  flush()
  if #lines == 0 then
    lines[1] = ""
  end
  return lines
end

--- Compute content widths for `ncols` columns summing to `avail`: expand the
--- natural widths evenly (opentui "full" mode fills the table to the target
--- width), or shrink by sqrt-weighted water-fill floored at each column's
--- longest word (wide columns give up proportionally more than narrow ones).
---@param rows string[][] header first
---@param ncols integer
---@param avail integer
---@return integer[]
local function tw_column_widths(rows, ncols, avail)
  local natural, minw = {}, {}
  for j = 1, ncols do
    natural[j], minw[j] = 1, 1
  end
  for _, row in ipairs(rows) do
    for j = 1, ncols do
      local cell = row[j] or ""
      natural[j] = math.max(natural[j], tw_width(cell))
      local mw = 1
      for _, w in ipairs(tw_words(cell)) do
        mw = math.max(mw, tw_width(w))
      end
      minw[j] = math.max(minw[j], mw)
    end
  end

  local natsum, minsum = 0, 0
  for j = 1, ncols do
    natsum = natsum + natural[j]
    minsum = minsum + minw[j]
  end

  local widths = {}
  if natsum <= avail then
    local extra = avail - natsum
    local shared = math.floor(extra / ncols)
    local rem = extra % ncols
    for j = 1, ncols do
      widths[j] = natural[j] + shared + (j <= rem and 1 or 0)
    end
    return widths
  end

  local floors = minw
  if minsum > avail then
    floors = {}
    for j = 1, ncols do
      floors[j] = 1
    end
  end

  local budget = avail
  for j = 1, ncols do
    budget = budget - floors[j]
    widths[j] = floors[j]
  end
  local cap, wsum = {}, 0.0
  for j = 1, ncols do
    cap[j] = natural[j] - floors[j]
    wsum = wsum + math.sqrt(cap[j])
  end
  local frac, used = {}, 0
  for j = 1, ncols do
    local g = 0
    if wsum > 0 and cap[j] > 0 then
      local exact = (budget / wsum) * math.sqrt(cap[j])
      g = math.min(cap[j], math.floor(exact + 1e-9))
      frac[j] = exact - g
    else
      frac[j] = -1
    end
    widths[j] = widths[j] + g
    used = used + g
  end
  -- Largest-remainder pass for the units the flooring dropped.
  local order = {}
  for j = 1, ncols do
    order[j] = j
  end
  table.sort(order, function(a, b)
    return frac[a] > frac[b]
  end)
  local i = 1
  while used < budget do
    local j = order[((i - 1) % ncols) + 1]
    i = i + 1
    if widths[j] < natural[j] then
      widths[j] = widths[j] + 1
      used = used + 1
    end
    if i > budget + ncols + 4 then
      break -- paranoia: budget <= sum(cap) always terminates, but be safe
    end
  end
  return widths
end

--- Right-pad a string to a display width.
---@param s string
---@param width integer
---@return string
local function tw_pad(s, width)
  return s .. string.rep(" ", math.max(0, width - tw_width(s)))
end

--- One physical line from per-column segment texts.
local function tw_join(cells, widths)
  local padded = {}
  for j = 1, #widths do
    padded[j] = tw_pad(cells[j] or "", widths[j])
  end
  return "| " .. table.concat(padded, " | ") .. " |"
end

--- Rule row between logical rows. Filled with "=", not "-": tree-sitter
--- (unlike strict GFM) parses a dashes-line after a data row as the
--- delimiter row of a NEW table, which would fragment re-parsing; equals
--- stay ordinary rows in every parser while still reading as a rule.
--- Emitted in the same padded `| x |` form as data rows with trimmed
--- width equal to the column width -- anything wider would make mdformat
--- grow the column on the next ,f.
local function tw_rule(widths)
  local cells = {}
  for j, w in ipairs(widths) do
    cells[j] = tw_pad(string.rep("=", w), w)
  end
  return "| " .. table.concat(cells, " | ") .. " |"
end

--- Delimiter row with the original alignment markers preserved, padded in
--- the same `| x |` form and trimmed width as data rows (see tw_rule).
local function tw_delimiter(aligns, widths)
  local cells = {}
  for j, w in ipairs(widths) do
    local a = aligns[j] or "none"
    local cell
    if a == "left" then
      cell = ":" .. string.rep("-", math.max(1, w - 1))
    elseif a == "right" then
      cell = string.rep("-", math.max(1, w - 1)) .. ":"
    elseif a == "center" then
      cell = ":" .. string.rep("-", math.max(0, w - 2)) .. ":"
    else
      cell = string.rep("-", w)
    end
    cells[j] = tw_pad(cell, w)
  end
  return "| " .. table.concat(cells, " | ") .. " |"
end

--- Cell texts of a header/row node (pipe_table_cell children, trimmed).
---@param row_node TSNode
---@return string[]
local function tw_row_cells(row_node)
  local cells = {}
  for child in row_node:iter_children() do
    if child:type() == "pipe_table_cell" then
      cells[#cells + 1] = tw_trim(vim.treesitter.get_node_text(child, 0))
    end
  end
  return cells
end

--- Alignment kinds from the delimiter row, padded with "none".
local function tw_aligns(delim_node, ncols)
  local aligns = {}
  if delim_node then
    for child in delim_node:iter_children() do
      if child:type() == "pipe_table_delimiter_cell" then
        local txt = tw_trim(vim.treesitter.get_node_text(child, 0))
        local l, r = txt:sub(1, 1) == ":", txt:sub(-1) == ":"
        if l and r then
          aligns[#aligns + 1] = "center"
        elseif l then
          aligns[#aligns + 1] = "left"
        elseif r then
          aligns[#aligns + 1] = "right"
        else
          aligns[#aligns + 1] = "none"
        end
      end
    end
  end
  while #aligns < ncols do
    aligns[#aligns + 1] = "none"
  end
  return aligns
end

--- True for a row whose every cell is rule filler (dashes or equals) -- a
--- rule row emitted by a previous wrap (recognized so re-wrapping
--- converges). A legitimate data row of only filler would be dropped too;
--- vanishingly rare, accepted.
local function tw_is_rule_row(cells)
  if #cells == 0 then
    return false
  end
  for _, c in ipairs(cells) do
    if not (c:match("^[:=%-]+$") and c:match("[%-=]")) then
      return false
    end
  end
  return true
end

_G.__markdown_wrap_tables = function(start_line, end_line)
  if not (start_line and end_line) then
    start_line = vim.api.nvim_buf_get_mark(0, "<")[1]
    end_line = vim.api.nvim_buf_get_mark(0, ">")[1]
  end
  if not start_line or start_line == 0 or not end_line or end_line == 0 then
    vim.notify("table-wrap: no visual selection", vim.log.levels.WARN)
    return
  end
  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  local parser_ok, parser = pcall(vim.treesitter.get_parser, 0, "markdown")
  if not parser_ok or not parser then
    vim.notify("table-wrap: markdown parser unavailable", vim.log.levels.WARN)
    return
  end
  local query_ok, q = pcall(vim.treesitter.query.parse, "markdown",
    "(pipe_table) @table")
  if not query_ok or not q then
    vim.notify("table-wrap: pipe_table query failed", vim.log.levels.WARN)
    return
  end

  local sel_srow, sel_erow = start_line - 1, end_line - 1
  local tables = {}
  for _, node in q:iter_captures(parser:parse(true)[1]:root(), 0, 0, -1) do
    local srow, _, erow, ecol = node:range()
    local last_row = (ecol == 0 and erow > srow) and (erow - 1) or erow
    if srow <= sel_erow and last_row >= sel_srow then
      tables[#tables + 1] = { node = node, srow = srow, last_row = last_row }
    end
  end
  if #tables == 0 then
    vim.notify("table-wrap: no table in selection", vim.log.levels.WARN)
    return
  end

  local target = vim.bo.textwidth
  if not target or target <= 0 then
    target = 80
  end

  -- Replace bottom-up so earlier table ranges stay valid.
  table.sort(tables, function(a, b) return a.srow > b.srow end)

  local converted, skipped = 0, 0
  for _, t in ipairs(tables) do
    -- A table already laid out at the target width is canonical output:
    -- skip it. Re-wrapping cannot recover logical-row grouping (GFM has no
    -- multi-line cells), so a re-wrap would rule between every segment.
    local raw = vim.api.nvim_buf_get_lines(0, t.srow, t.last_row + 1, false)
    local canonical = #raw > 0
    for _, l in ipairs(raw) do
      if tw_width(l) ~= target then
        canonical = false
        break
      end
    end
    if canonical then
      skipped = skipped + 1
      goto continue
    end

    local header_node, delim_node, rows = nil, nil, {}
    for child in t.node:iter_children() do
      local ty = child:type()
      if ty == "pipe_table_header" then
        header_node = child
      elseif ty == "pipe_table_delimiter_row" then
        delim_node = child
      elseif ty == "pipe_table_row" then
        local cells = tw_row_cells(child)
        if not tw_is_rule_row(cells) then
          rows[#rows + 1] = cells
        end
      end
    end
    if not header_node then
      goto continue
    end

    local all = { tw_row_cells(header_node) }
    vim.list_extend(all, rows)
    local ncols = 0
    for _, row in ipairs(all) do
      ncols = math.max(ncols, #row)
    end
    if ncols == 0 then
      goto continue
    end

    -- Pipes (ncols+1) plus one space of cell padding on each side (2*ncols).
    local avail = target - (ncols + 1) - 2 * ncols
    if avail < ncols then
      avail = ncols -- pathological column count: min widths, table overflows
    end
    local widths = tw_column_widths(all, ncols, avail)
    local aligns = tw_aligns(delim_node, ncols)

    -- Wrap every cell, then emit each row's segments as physical lines.
    local segments = {}
    for _, row in ipairs(all) do
      local cols = {}
      for j = 1, ncols do
        cols[j] = tw_wrap(row[j] or "", widths[j])
      end
      local n = 1
      for j = 1, ncols do
        n = math.max(n, #cols[j])
      end
      local seg = {}
      for s = 1, n do
        local cells = {}
        for j = 1, ncols do
          cells[j] = cols[j][s] or ""
        end
        seg[s] = tw_join(cells, widths)
      end
      segments[#segments + 1] = seg
    end

    local new_lines = {}
    vim.list_extend(new_lines, segments[1])
    new_lines[#new_lines + 1] = tw_delimiter(aligns, widths)
    for i = 2, #segments do
      if i > 2 then
        new_lines[#new_lines + 1] = tw_rule(widths)
      end
      vim.list_extend(new_lines, segments[i])
    end
    vim.api.nvim_buf_set_lines(0, t.srow, t.last_row + 1, false, new_lines)
    converted = converted + 1

    ::continue::
  end

  -- Drop the visual selection highlight left behind by the x-mode mapping.
  if vim.fn.mode():find("^[vV\22]") then
    vim.cmd("normal! \27")
  end

  local msg = ("table-wrap: wrapped %d table(s) to width %d"):format(converted, target)
  if skipped > 0 then
    msg = msg .. (", skipped %d (already at width)"):format(skipped)
  end
  vim.notify(msg, vim.log.levels.INFO)
end

vim.keymap.set("x", "<leader>tw", function()
  _G.__markdown_wrap_tables()
end, { silent = true, buffer = true, desc = "Markdown: wrap table to textwidth" })
