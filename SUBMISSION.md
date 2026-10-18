# AI Usage Triage — Take Home

Run: `python3 -m http.server 4173`, then open http://localhost:4173.
Time spent: ~2 hours.

* I wanted the review queue to stay small, but not feel like a black box. The 250 records turn into 3 cases. There are also 4 patterns the app notices but doesn't flag: a completed retry loop, a batch project that looks internally consistent, blocked attempts, and personal accounts with no other signal. I thought it was important to show those too so an admin can understand what the system chose not to surface.
* The thresholds are based on the dataset rather than hardcoded to these examples. Nothing keys off the excerpt text, and the cost thresholds are calculated per department. I tested this by rewriting all the excerpts and scaling costs from 0.01x to 50x, and the same cases still surfaced.
* Repeated content gets grouped, not hidden. In this dataset, a template and the same disclosure sent five times can look basically identical. I'd rather collapse that into one lower-ranked case that an admin can dismiss than automatically suppress something that could still be a real leak.
* The admin can disagree with the system. Anything the app explains away can be promoted into a case, and any flagged case can be dismissed with a reason. Both actions are reversible and reflected in the summary.
* I also used Claude Code to try to break the logic, not just build the app. I had it generate synthetic CSVs at different scales and edge cases. That caught two issues: an all-zero-cost dataset was flagging every session, and repeated-content grouping could accidentally hide ten separate leaks.
