#!/usr/bin/env python3

import sys
import asyncio
import json
from pathlib import Path

try:
    from gemini_webapi import set_log_level
    set_log_level("ERROR")
except ImportError:
    pass

def print_help():
    help_text = """Usage: webapi [OPTIONS] PROMPT

All-purpose Gemini 3 Pro client with Thinking enabled.
Uses browser cookies for authentication - no API key required.

Arguments:
  PROMPT                Text prompt for query/generation

Options:
  --file, -f FILE       Input file (MP4, PDF, PNG, JPG, etc.)
  --youtube URL         YouTube video URL to analyze
  --generate-image FILE Generate image and save to FILE
  --edit IMAGE          Edit existing image (use with --output)
  --output, -o FILE     Output file path (for image generation/editing)
  --aspect RATIO        Aspect ratio for image generation (16:9, 1:1, 4:3, 3:4)
  --show-thoughts       Display model's thinking process
  --model MODEL         Model to use (default: gemini-3.0-pro)
  --json                Output response as JSON
  --help, -h            Show this help message

Examples:
  # Text query
  webapi "Explain quantum computing"

  # Analyze local video
  webapi "Summarize this video" --file video.mp4

  # Analyze YouTube video
  webapi "What are the key points?" --youtube "https://youtube.com/watch?v=..."

  # Analyze document
  webapi "Summarize this report" --file report.pdf

  # Generate image
  webapi "A sunset over mountains" --generate-image sunset.png

  # Edit image
  webapi "Make the sky purple" --edit photo.jpg --output edited.png

  # Show thinking process
  webapi "Solve this step by step: What is 15% of 240?" --show-thoughts

Model: gemini-3.0-pro (Thinking with 3 Pro)

Prerequisites:
  1. Log into gemini.google.com in Chrome
  2. pip install -r requirements.txt (or use the venv)
  3. First run on macOS will prompt for Keychain access"""
    print(help_text)

def parse_args(args):
    result = {
        "prompt": None,
        "file": None,
        "youtube": None,
        "generate_image": None,
        "edit": None,
        "output": None,
        "aspect": None,
        "show_thoughts": False,
        "model": "gemini-3.0-pro",
        "json_output": False,
    }

    i = 0
    positional = []

    while i < len(args):
        arg = args[i]

        if arg in ("--help", "-h"):
            print_help()
            sys.exit(0)
        elif arg in ("--file", "-f"):
            i += 1
            if i >= len(args):
                print("Error: --file requires a path", file=sys.stderr)
                sys.exit(1)
            result["file"] = args[i]
        elif arg == "--youtube":
            i += 1
            if i >= len(args):
                print("Error: --youtube requires a URL", file=sys.stderr)
                sys.exit(1)
            result["youtube"] = args[i]
        elif arg == "--generate-image":
            i += 1
            if i >= len(args):
                print("Error: --generate-image requires an output filename", file=sys.stderr)
                sys.exit(1)
            result["generate_image"] = args[i]
        elif arg == "--edit":
            i += 1
            if i >= len(args):
                print("Error: --edit requires an input image", file=sys.stderr)
                sys.exit(1)
            result["edit"] = args[i]
        elif arg in ("--output", "-o"):
            i += 1
            if i >= len(args):
                print("Error: --output requires a filename", file=sys.stderr)
                sys.exit(1)
            result["output"] = args[i]
        elif arg == "--aspect":
            i += 1
            if i >= len(args):
                print("Error: --aspect requires a ratio", file=sys.stderr)
                sys.exit(1)
            result["aspect"] = args[i]
        elif arg == "--show-thoughts":
            result["show_thoughts"] = True
        elif arg == "--model":
            i += 1
            if i >= len(args):
                print("Error: --model requires a model name", file=sys.stderr)
                sys.exit(1)
            result["model"] = args[i]
        elif arg == "--json":
            result["json_output"] = True
        elif not arg.startswith("-"):
            positional.append(arg)
        else:
            print(f"Error: Unknown option {arg}", file=sys.stderr)
            sys.exit(1)

        i += 1

    if not positional:
        print("Error: PROMPT is required", file=sys.stderr)
        print("Use --help for usage information", file=sys.stderr)
        sys.exit(1)

    result["prompt"] = " ".join(positional)
    return result

async def run(args):
    try:
        from gemini_webapi import GeminiClient
    except ImportError:
        print("Error: gemini-webapi not installed", file=sys.stderr)
        print("Run: pip install -r requirements.txt", file=sys.stderr)
        sys.exit(1)

    prompt = args["prompt"]
    files = []

    if args["aspect"] and (args["generate_image"] or args["edit"]):
        prompt = f"{prompt} (aspect ratio: {args['aspect']})"

    if args["file"]:
        file_path = Path(args["file"])
        if not file_path.exists():
            print(f"Error: File not found: {args['file']}", file=sys.stderr)
            sys.exit(1)
        files.append(str(file_path.resolve()))

    edit_image_path = None
    if args["edit"]:
        edit_path = Path(args["edit"])
        if not edit_path.exists():
            print(f"Error: Image not found: {args['edit']}", file=sys.stderr)
            sys.exit(1)
        edit_image_path = str(edit_path.resolve())

    if args["youtube"]:
        prompt = f"{prompt}\n\nYouTube video: {args['youtube']}"

    if args["generate_image"] and not args["edit"]:
        prompt = f"Generate an image: {prompt}"

    model = args["model"]

    print(f"Initializing Gemini client...", file=sys.stderr)

    try:
        client = GeminiClient()
        await client.init(timeout=120, auto_close=False, auto_refresh=True)
    except Exception as e:
        print(f"Error initializing client: {e}", file=sys.stderr)
        print("Make sure you're logged into gemini.google.com in Chrome", file=sys.stderr)
        sys.exit(1)

    print(f"Querying {model}...", file=sys.stderr)

    try:
        if edit_image_path:
            chat = client.start_chat()
            await chat.send_message("Here is an image to edit", files=[edit_image_path])
            edit_prompt = f"Use image generation tool to {prompt}"
            response = await chat.send_message(edit_prompt)
        elif files:
            response = await client.generate_content(prompt, files=files, model=model)
        else:
            response = await client.generate_content(prompt, model=model)

        if args["generate_image"] or edit_image_path:
            if not response.images:
                print("No images generated. Response text:", file=sys.stderr)
                if response.text:
                    print(response.text)
                else:
                    print("(empty response)")
                sys.exit(1)

            output_path = Path(args["generate_image"] or args["output"] or "generated.png")
            output_dir = output_path.parent if output_path.parent != Path(".") else Path(".")

            image = response.images[0]
            await image.save(path=str(output_dir), filename=output_path.name)

            if len(response.images) > 1:
                print(f"({len(response.images)} images generated, saved first one)", file=sys.stderr)

            if args["json_output"]:
                output = {
                    "text": f"Saved: {output_path}",
                    "thoughts": None,
                    "has_images": True,
                    "image_count": len(response.images),
                }
                print(json.dumps(output, indent=2))
            else:
                print(f"Saved: {output_path}")
                if response.text:
                    print(f"\nResponse: {response.text}")
        else:
            if args["json_output"]:
                output = {
                    "text": response.text,
                    "thoughts": response.thoughts if args["show_thoughts"] else None,
                    "has_images": bool(response.images),
                    "image_count": len(response.images) if response.images else 0,
                }
                print(json.dumps(output, indent=2))
            else:
                if args["show_thoughts"] and response.thoughts:
                    print("=== Thinking ===")
                    print(response.thoughts)
                    print("\n=== Response ===")

                if response.text:
                    print(response.text)
                else:
                    print("(empty response)")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.close()

def main():
    args = parse_args(sys.argv[1:])
    asyncio.run(run(args))

if __name__ == "__main__":
    main()
