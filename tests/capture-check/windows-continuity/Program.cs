using System;
using Spindle;

internal static class Program {
    static void Require(bool value, string scenario) {
        if (!value) throw new Exception(scenario);
    }
    static void Main() {
        ObservationContinuity guard = new ObservationContinuity();
        guard.Start(0);
        for (uint at = 50; at <= 700; at += 50)
            Require(guard.Observe(at, at, at), "normal 50 ms observations must continue");
        Require(!guard.Observe(5200, 5200, null), "4.5 s reader suspension must invalidate coverage even if timer runs before queued events");
        Require(guard.ReliableThrough == 700, "suspended time must not extend the last observation");

        guard.Start(0);
        for (uint at = 50; at <= 5200; at += 50)
            Require(guard.Observe(at, at, null), "normal polling must continue");
        Require(!guard.Observe(5201, 5201, 750), "a delayed callback must fail even when polling was not delayed");
        Require(guard.ReliableThrough == 750, "late source events must invalidate later polling, not keep its fabricated duration");

        guard.Start(6000);
        Require(guard.Observe(6050, 6050, 750), "queued events from before a fresh recording must not fail its retry");
        Require(guard.Observe(6100, 6100, 6090), "fresh recording must accept current events");
        guard.Start(0);
        for (uint at = 50; at <= 6100; at += 50)
            Require(guard.Observe(at, at, null), "ordinary polling must advance before the rollover scenario");
        Require(guard.Observe(6150, 20, unchecked(20u - 50u)), "TickCount rollover must not look like a delay");
        Require(!guard.Observe(6200, 70, unchecked(70u - 1100u)), "delayed events spanning TickCount rollover must still be detected");

        guard.Start(7000);
        Require(guard.Observe(8000, 8000, null), "the exact watchdog ceiling remains allowed");
        Require(!guard.Observe(9001, 9001, null), "exceeding the ceiling must stop observation");
        Console.WriteLine("Windows continuity: suspension, delayed callback, retry, clock rollover and watchdog boundary passed (deterministic, not native UI Automation).");
    }
}
