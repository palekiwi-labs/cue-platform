# https://nvf.notashelf.dev/options.html

{ pkgs, nvf, ... }:
let
  customNeovim = nvf.lib.neovimConfiguration {
    inherit pkgs;
    modules = [
      {
        config.vim = {
          # Pure, reproducible runtime tree appended to Neovim's 'runtimepath'
          # by nvf at build time. Neovim loads ftplugins from each rtp dir as
          # <dir>/ftplugin/<ft>/init.lua, so this directory must CONTAIN the
          # ftplugin/ folder (not be the folder itself).
          additionalRuntimePaths = [ ./runtime ];

          utility.motion.hop = {
            enable = true;
          };
          # <leader> prefix for on-demand mappings (e.g. <leader>f markdown
          # format-all, <leader>md mdformat-only). Overrides nvf's default of
          # Space. Note: this shadows the
          # builtin `,` (reverse-repeat of f/F/t/T); forward repeat via `;`
          # is unaffected.
          globals.mapleader = ",";
          lineNumberMode = "number";
          # autocmds = [
          #   {
          #     event = [ "VimEnter" ];
          #     pattern = [ "*" ];
          #     command = "startinsert";
          #   }
          # ];
          options = {
            scrolloff = 5;
          };
          luaConfigPost = ''
            vim.g.clipboard = {
              name = 'OSC 52',
              copy = {
                ['+'] = require('vim.ui.clipboard.osc52').copy('+'),
                ['*'] = require('vim.ui.clipboard.osc52').copy('*'),
              },
              paste = {
                ['+'] = require('vim.ui.clipboard.osc52').paste('+'),
                ['*'] = require('vim.ui.clipboard.osc52').paste('*'),
              },
            }

            -- Match opencode's "github dark" markdown rendering.
            -- See .cue/master/task/match-opencode-markdown-scheme.md.
            -- This runs in luaConfigPost (after the colorscheme and
            -- render-markdown setup) so the explicit non-default calls
            -- win over both the github theme and render-markdown's
            -- default=true links. Re-applied on any later colorscheme
            -- change.
            do
              local function apply()
                vim.api.nvim_set_hl(0, "@markup.strong", { fg = "#d29922", bold = true })
                vim.api.nvim_set_hl(0, "@markup.strong.markdown_inline", { fg = "#d29922", bold = true })
                vim.api.nvim_set_hl(0, "@markup.italic", { fg = "#e3b341", italic = true })
                vim.api.nvim_set_hl(0, "@markup.italic.markdown_inline", { fg = "#e3b341", italic = true })
                vim.api.nvim_set_hl(0, "@markup.link", { fg = "#39c5cf", underline = true })
                vim.api.nvim_set_hl(0, "@markup.link.markdown_inline", { fg = "#39c5cf", underline = true })
                vim.api.nvim_set_hl(0, "@markup.link.label", { fg = "#39c5cf", underline = true })
                vim.api.nvim_set_hl(0, "@markup.link.label.markdown_inline", { fg = "#39c5cf", underline = true })
                vim.api.nvim_set_hl(0, "@markup.link.url", { fg = "#58a6ff", underline = true })
                vim.api.nvim_set_hl(0, "@markup.link.url.markdown_inline", { fg = "#58a6ff", underline = true })
                vim.api.nvim_set_hl(0, "@markup.raw.markdown_inline", { fg = "#FF7B72" })
                vim.api.nvim_set_hl(0, "RenderMarkdownLink", { fg = "#39c5cf", underline = true })
                vim.api.nvim_set_hl(0, "RenderMarkdownLinkTitle", { fg = "#58a6ff", underline = true })
                vim.api.nvim_set_hl(0, "RenderMarkdownCode", { bg = "#161b22" })
                vim.api.nvim_set_hl(0, "RenderMarkdownCodeInline", { fg = "#FF7B72", bg = "#161b22" })
                vim.api.nvim_set_hl(0, "RenderMarkdownDash", { fg = "#30363d" })
              end
              apply()
              vim.api.nvim_create_autocmd("ColorScheme", {
                group = vim.api.nvim_create_augroup("OpencodeMarkdownTheme", { clear = true }),
                callback = apply,
              })
            end
          '';
          theme = {
            enable = true;
            name = "github";
            style = "dark_default";
          };
          treesitter.enable = true;
          autocomplete.nvim-cmp = {
            enable = true;
            mappings = {
              confirm = "<C-e>";
              close = null;
              next = "<Down>";
              previous = "<Up>";
            };
            setupOpts = {
              sources = pkgs.lib.mkForce [
                {
                  name = "path";
                  option = {
                    get_cwd = pkgs.lib.generators.mkLuaInline "function() return vim.fn.getcwd() end";
                  };
                }
              ];
            };
          };
          keymaps = [
            {
              key = "<Down>";
              mode = [ "n" "v" ];
              silent = true;
              action = "gj";
            }
            {
              key = "<Up>";
              mode = [ "n" "v" ];
              silent = true;
              action = "gk";
            }
            {
              key = "<C-c>";
              mode = [ "v" ];
              silent = true;
              action = ''"+y'';
            }
            {
              key = "<Find>";
              mode = [ "n" "i" "v" "c" "x" ];
              silent = true;
              action = "<Home>";
            }
            {
              key = "<Select>";
              mode = [ "n" "i" "v" "c" "x" ];
              silent = true;
              action = "<End>";
            }
            {
              key = "s";
              mode = [ "n" "v" ];
              silent = true;
              action = "<cmd>HopChar1<CR>";
            }
            {
              key = "l";
              mode = [ "n" "v" ];
              silent = true;
              action = "<cmd>HopLineStart<CR>";
            }
          ];
          languages.json.enable = true;
          languages.json.treesitter.enable = true;
          languages.nix.enable = true;
          languages.nix.treesitter.enable = true;
          languages.ruby.enable = true;
          languages.ruby.treesitter.enable = true;
          languages.rust.enable = true;
          languages.rust.treesitter.enable = true;
          languages.typescript.enable = true;
          languages.typescript.treesitter.enable = true;
          languages.markdown.enable = true;
          languages.markdown.treesitter.enable = true;
          # Markdown injects yaml into frontmatter; without this grammar the
          # whole frontmatter block renders as a single highlight group.
          languages.yaml.enable = true;
          languages.yaml.treesitter.enable = true;
          # Structural markdown formatter run on demand via <leader>md (see
          # runtime/ftplugin/markdown/init.lua). nvf's "mdformat" selector
          # bundles mdformat + gfm/frontmatter/footnote plugins. mdformat
          # defaults to --wrap=keep, so it normalizes structure (blank lines
          # around headings/lists, list markers, trailing whitespace) without
          # reflowing prose -- wrapping stays the job of the `gw` operator.
          languages.markdown.format = {
            enable = true;
            type = ["mdformat"];
          };
          languages.markdown.extensions.render-markdown-nvim = {
            enable = true;
            setupOpts = {};
          };
        };
      }
    ];
  };
in
customNeovim.neovim
