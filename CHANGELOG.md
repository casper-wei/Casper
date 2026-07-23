# Changelog

## 0.1.0 - 2026-07-23

### Added
- Integrated dark trading dashboard as the main GitHub Pages experience.
- Added daily strategy records, candidate list, candlestick chart, stop-loss and take-profit levels.
- Added short-term swing strategy and moving-average breakout strategy.
- Added value screener panel with PE, PB, dividend yield, estimated ROE, fair value range, technical entry, backtest return, and value-trap warnings.
- Added GitHub Actions snapshot refresh for market data, candidates, and value screener data.

### Changed
- Market status now shows filtered stock counts and data date instead of raw official row counts.
- Moving-average breakout strategy now uses 5MA, 10MA, 20MA compression, 20-day high breakout, and 1.5x 20-day average volume.

### Security
- Snapshot workflow uses public official data and does not require API keys.
- Sensitive local files such as `.env`, keys, and certificates are ignored by Git.
