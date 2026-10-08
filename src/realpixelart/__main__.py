"""CLI summary on stdout; warnings and detailed timings on stderr."""
import argparse
from pathlib import Path
import sys
from .config import Config, PALETTE_IDS
from .pipeline import pixelize
from .tools import save_result


def parser():
    p = argparse.ArgumentParser(description="Restore pseudo pixel art to native low-resolution PNG.")
    p.add_argument("-i", "--input", required=True, type=Path)
    p.add_argument("-o", "--output", type=Path, help="default: project output/<input-stem>.png")
    p.add_argument("--colors", type=int, help="optional maximum visible RGB colors (1-512); default unlimited")
    p.add_argument("--no-semitransparent", action="store_true",
                   help="postprocess alpha: below 75% (192/255) becomes transparent, otherwise opaque")
    p.add_argument("--palette", nargs="?", const="DMC436", choices=PALETTE_IDS,
                   help="optional bead library; flag without a name selects DMC436")
    p.add_argument("--color-mode", choices=("natural", "rgb"), default="natural",
                   help="postprocessing distance: natural (Lab/CIEDE2000) or RGB")
    p.add_argument("--scale", type=int, default=1, help="integer nearest-neighbor export multiplier (1-16)")
    p.add_argument("--sampling", choices=("robust", "center", "median"), default="robust")
    p.add_argument("--alpha-mode", choices=("auto", "binary", "coverage"), default="auto",
                   help="auto: sampled alpha; binary: explicit threshold; coverage: averaged alpha")
    p.add_argument("--local-warp", choices=("auto", "off"), default="auto")
    p.add_argument("--photo-mode", choices=("auto", "off"), default="auto",
                   help="pixelize ordinary images and unreliable-grid inputs; off disables rendering fallback")
    p.add_argument("--min-pixel-size", type=float, default=2)
    p.add_argument("--max-pixel-size", type=float, default=64)
    p.add_argument("--square", action="store_true", help="require equal nominal x/y spacing")
    p.add_argument("--debug", action="store_true", help="write diagnostic files to output/debug/<output-stem>/")
    p.add_argument("--debug-dir", type=Path, help="override diagnostic directory; requires --debug")
    p.add_argument("--verbose", action="store_true")
    return p


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    if args.debug_dir is not None and not args.debug:
        p.error("--debug-dir requires --debug")
    try:
        config = Config(colors=args.colors, palette=args.palette, color_mode=args.color_mode,
                        no_semitransparent=args.no_semitransparent,
                        scale=args.scale, sampling=args.sampling, local_warp=args.local_warp,
                        alpha_mode=args.alpha_mode, photo_mode=args.photo_mode,
                        min_pixel_size=args.min_pixel_size, max_pixel_size=args.max_pixel_size,
                        square=args.square)
        checkout = Path(__file__).resolve().parents[2]
        root = checkout if (checkout / "realpixelart.py").is_file() else Path.cwd()
        if args.output is None:
            args.output = root / "output" / (args.input.stem + ".png")
        if args.output.suffix.lower() != ".png":
            raise ValueError("output must have a .png extension")
        if args.input.resolve() == args.output.resolve():
            raise ValueError("input and output paths must differ")
        result = pixelize(args.input, config)
        debug_dir = (args.debug_dir or root / "output" / "debug" / args.output.stem) if args.debug else None
        save_result(result, args.output, args.scale, debug_dir=debug_dir, debug=args.debug)
        print(f"grid={result.image.width}x{result.image.height}; "
              f"pixel spacing={result.grid['sx']:.3f}x{result.grid['sy']:.3f}; "
              f"confidence={result.confidence:.3f}; "
              f"alpha={result.diagnostics['structure']['alpha_mode']}; "
              f"time={result.timings['total_with_export']:.3f}s; output={args.output}")
        for message in result.diagnostics["warnings"]:
            print(f"realpixelart: {message}", file=sys.stderr)
        color_info = result.diagnostics["color_processing"]
        if color_info["applied"]:
            print(f"colors={color_info['output_colors']}; palette={args.palette or 'adaptive'}; "
                  f"limit={args.colors or 'unlimited'}; color mode={args.color_mode}")
        if args.verbose:
            print(f"native={result.image.width}x{result.image.height}; heuristic confidence={result.confidence:.3f}; "
                  f"export scale={args.scale}", file=sys.stderr)
            for name, seconds in result.timings.items():
                print(f"  {name}: {seconds:.4f} s", file=sys.stderr)
        return 0
    except MemoryError:
        print("realpixelart: error: insufficient memory for this image; use a machine with more available memory.", file=sys.stderr)
        return 2
    except (ValueError, TypeError, OSError) as exc:
        print(f"realpixelart: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
