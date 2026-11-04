# Benchmarks

How Hindsight compares with other recorders on real PCs, measured with Hindsight's built-in **Performance** test.

## Share a result

1. In Hindsight, open **Performance** and run the test with the recorders you have (OBS replay buffer, NVIDIA Instant Replay, Medal).
2. Click **Share on GitHub**. It copies the full results and opens the [benchmark form](https://github.com/aattiaibrahim/Rewind/issues/new?template=benchmark.yml).
3. Paste the results, fill in your PC, and drag in screenshots: the Results page, each recorder's settings, anything odd.

Every submission is a GitHub issue labelled [`benchmark`](https://github.com/aattiaibrahim/Rewind/issues?q=label%3Abenchmark), so all results stay public and linkable. Notable ones are summarised in the table below.

## What the test measures (and doesn't)

- **Measures:** what each recorder costs your game. That covers FPS, 1% lows and GPU time per frame (from Intel PresentMon), plus CPU, GPU, encoder and RAM use.
- **Method:**
  - Nothing-recording runs and recorder runs are interleaved in a shuffled order, after a warm-up.
  - Each recorder is compared with the runs either side of it.
  - Results carry 95% confidence ranges; a difference inside the game's own noise is reported as "no measurable cost".
- **Checks:** every run is checked (game in front, the right recorder encoding, nothing else encoding). The test warns about V-Sync, FPS caps, CPU-bound scenes and mismatched recorder settings.
- **Doesn't measure:** video quality. Comparing how good the clips look needs equal bitrates and a quality score like VMAF; that's not part of this test yet.

## For a fair run

- Turn V-Sync and any FPS cap off, or the cost hides under the cap.
- Stand in the same quiet spot, or use a built-in benchmark.
- Set every recorder to the same resolution and frame rate (the test warns when they differ).
- Close recorders you aren't testing. If OBS runs as administrator, close it first.
- Use 3 or more rounds.

## Results

| Date | PC (GPU / CPU) | Game | Hindsight | OBS | NVIDIA | Medal | Link |
|------|----------------|------|--------|-----|--------|-------|------|
| _No submissions yet_ | | | | | | | |

Values are the average FPS change against nothing recording, with the 95% range.
