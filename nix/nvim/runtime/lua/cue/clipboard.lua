-- Copy-to-clipboard utilities for the current buffer: file path,
-- path with cursor, path with visual range. Ported from nix-config's
-- config/utils/context_clipboard.lua (the <leader>c family).
-- All writes go to the '+' register, which the OSC 52 clipboard
-- provider forwards to the local client over SSH.
local M = {}

---Copy the current buffer's path to the clipboard.
---@param include_cursor boolean append " L{line}:C{col}"
---@param relative? boolean when true, path is relative to cwd (`:.`)
M.copy_file_path = function(include_cursor, relative)
  local modifier = relative and ':.' or ':p'
  local filepath = vim.fn.fnamemodify(vim.fn.expand('%'), modifier)
  local result = filepath

  if include_cursor then
    local cursor = vim.api.nvim_win_get_cursor(0)
    local line = cursor[1]
    local col = cursor[2] + 1
    result = string.format("%s L%d:C%d", filepath, line, col)
  end

  vim.fn.setreg('+', result)
  vim.notify(string.format("Copied: %s", result), vim.log.levels.INFO)
end

M.copy_file_with_visual_range = function()
  local start_line = vim.fn.line('v')
  local end_line = vim.fn.line('.')  ---@type integer

  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  -- Use "path:line" so the result works with gF; gF ignores the "-end"
  -- part of a range and jumps to the first line.
  local filepath = vim.fn.fnamemodify(vim.fn.expand('%'), ':p')
  local result ---@type string
  if start_line == end_line then
    result = string.format("%s:%d", filepath, start_line)
  else
    result = string.format("%s:%d-%d", filepath, start_line, end_line)
  end

  vim.fn.setreg('+', result)
  vim.notify(string.format("Copied: %s", result), vim.log.levels.INFO)
end

return M
