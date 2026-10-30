// Preview safety watchdog, not an accepted timing/coverage budget. A stalled
// observer cannot reconstruct missed visits by sampling the current window.
namespace Spindle {
    internal sealed class ObservationContinuity {
        internal const double MaximumSilenceMs = 1000;
        double startedAt;
        internal double ReliableThrough { get; private set; }

        internal void Start(double at) { startedAt = ReliableThrough = at; }

        internal bool Observe(double at, uint tick, uint? eventTick) {
            bool continuous = at - ReliableThrough <= MaximumSilenceMs;
            if (eventTick.HasValue) {
                // WinEvent timestamps and TickCount share a wrapping 32-bit clock.
                uint age = unchecked(tick - eventTick.Value);
                // Ignore queued notifications from before this recording began.
                if (age > MaximumSilenceMs && at - age >= startedAt) {
                    ReliableThrough = System.Math.Min(ReliableThrough, at - age);
                    return false;
                }
            }
            if (!continuous) return false;
            ReliableThrough = at;
            return true;
        }
    }
}
