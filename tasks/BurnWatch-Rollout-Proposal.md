# BurnWatch Rollout Proposal

> **v2 note (2026-11-26):** BurnWatch is now team-level Claude Code cost and
> adoption, with a private view for each person. Several features below were
> removed or changed in v2: the leaderboard and scores, per-person stuck and
> onboarding lists, auto-picked champions, and named free-tier, MCP and
> account lists. Unused seats and setup checks stay named for admins only.
> See `tasks/V2-NO-MICROMANAGEMENT-PLAN.md` for what changed and why. The
> text below is the original proposal.

> **Focus:** Seat billing, adoption, and governance\
> **Purpose:** Reframe usage metrics for seat-based subscriptions and
> define the rollout features that help teams adopt AI tools
> responsibly.

## 1. Seat Billing Changes What the Numbers Mean

With seat-based billing, the company pays a fixed fee per seat.
Therefore, the dollar figures shown on the dashboard are **not money
spent**; they represent what the same usage would cost at API list
prices.

Presenting these figures as spend sends the wrong message. Heavy users
may appear expensive, when under seat billing they are getting more
value from a fixed subscription fee.

  -------------------------------------------------------------------------
  Current presentation    Problem under seat      Recommended change
                          billing                 
  ----------------------- ----------------------- -------------------------
  **"Ranked by AI spend"  Heavy users look like a Rename the figure to
  leaderboard**           cost, even though they  **API-equivalent value**.
                          may be getting the most Show actual cost (seat
                          out of a fixed-fee      price) and a **value
                          seat.                   multiple**
                                                  (`value ÷ seat price`).

  **Budget alerts in      A dollar cap has little Use alerts for idle seats
  dollars**               meaning when the bill   and limit hits. Keep
                          is fixed.               dollar alerts only for
                                                  users on API keys.

  **Overview "total       Management may mistake  Show **seats × price =
  cost"**                 the figure for the      actual cost** alongside
                          actual invoice.         **value received**.
  -------------------------------------------------------------------------

## 2. Pre-Rollout Blockers

These items should be addressed before rollout.

  ------------------------------------------------------------------------------------------
  Item                Why it is needed                                    Size
  ------------------- ------------------------------------- --------------------------------
  **Vercel Pro**      Hobby is licensed for non-commercial                Ops
                      use only. This is already noted in    
                      the roadmap.                          

  **Teams and manager The chosen model is "managers see                    M
  scope**             their team", but the manager role     
                      currently has no additional           
                      permissions. Every dashboard route    
                      goes through `viewerScope`, so the    
                      change can be made in one place.      

  **Path privacy**    The agent currently sends paths such                 S
                      as                                    
                      `/Users/<name>/code/<client-repo>`.   
                      Send the repository name and Git      
                      remote instead. This also enables     
                      client mapping (C1).                  

  **SSO login (Google With 50+ password accounts,                         S--M
  or Microsoft        password-reset requests will become a 
  through             recurring support burden.             
  better-auth)**                                            

  **"What BurnWatch   Show each developer exactly which                    S
  knows about me"     fields are collected and what their   
  page**              manager can see. Explicitly state     
                      that prompts and code are never       
                      collected. Transparency should help   
                      developers trust and continue using   
                      the tool.                             

  **Notification      Most of the proposed features need                   M
  channel (Slack or   notifications. Currently, alerts      
  Teams webhook, plus appear only as a dashboard banner.    
  email)**                                                  

  **Bulk invite from  Makes onboarding smoother for 50+                    S
  CSV; close BW-42    people.                               
  and finish BW-21**                                        
  ------------------------------------------------------------------------------------------

## 3. New Use Cases

### Data Source Key

-   ✅ **Already collected**
-   🟡 **Present in Claude transcripts, but the agent does not read it
    yet.** Checked locally on this machine using Claude Code `2.1.322`.
-   ⚪ **Requires admin input or an external source**

### A. Drive Adoption

  --------------------------------------------------------------------------------------------
  ID           Use case             Value           Data source                   Size
  ------------ -------------------- --------------- --------------------- --------------------
  **A1**       **Idle-seat          Under seat      ✅ Existing data + ⚪         S--M
               finder:** Identify   billing, this   plan per user         
               seats with no usage  is where real                         
               for 14+ days.        money can be                          
                                    saved: reclaim                        
                                    the seat or                           
                                    coach the                             
                                    person.                               

  **A2**       **Plan               Fewer           ✅ Value; 🟡                   M
               right-sizing:** Move complaints      limit-hit messages    
               a developer on a     about limits    (need to confirm how  
               high tier with low   and less        they are logged)      
               value down a tier;   overpayment.                          
               move a developer who                                       
               hits limits daily up                                       
               a tier.                                                    

  **A3**       **Adoption funnel    Gives the admin ✅ Existing data               S
               per team:** Invited  team one view                         
               → registered → first of rollout                            
               sync → active weekly progress. The                         
               → power user.        admin view                            
                                    already                               
                                    contains half                         
                                    the required                          
                                    data.                                 

  **A4**       **Nudges:** Remind   Reduces silent  ✅ Existing data      S after notification
               users who were       drop-off.                                   channel
               invited 3 days ago                                         
               but have not                                               
               registered; flag                                           
               devices silent for                                         
               48 hours; send a                                           
               day-7 check-in to                                          
               new joiners.                                               

  **A5**       **Feature-adoption   Distinguishes   ✅ MCP/tools; 🟡               M
               matrix:** Show the   people using    `attributionSkill`,   
               share of each team   Claude as       `isSidechain`,        
               using MCP, skills,   autocomplete    `permissionMode`,     
               subagents, plan      from those      `entrypoint`          
               mode, and CLI versus using it as an                        
               SDK.                 agent.                                

  **A6**       **What power users   Spreads good    ✅ Existing data + 🟡          M
               do differently:**    habits through  transcript fields     
               Compare the top      peer examples                         
               quartile with        rather than                           
               everyone else across management                            
               MCP setup, skills,   direction.                            
               and cache hit rate.                                        
               Generate tips such                                         
               as "4 teammates use                                        
               Playwright MCP".                                           

  **A7**       **Champions:**       Peer coaching   Derived from A5                S
               Select 1--2 power    scales better                         
               users per team to    than training                         
               coach others.        sessions.                             

  **A8**       **Healthier          Encourages      ✅ Existing data               S
               leaderboard:** Rank  healthy                               
               by active days,      competition                           
               streaks, and         around                                
               features tried. Hide effective use,                        
               dollar figures by    not spending                          
               default.             more.                                 
  --------------------------------------------------------------------------------------------

### B. Governance

  -------------------------------------------------------------------------------------
  ID           Use case              Value          Data source            Size
  ------------ --------------------- -------------- -------------- --------------------
  **B1**       **Free-tier ("shadow  Identifies     ✅ Existing             S
               AI") detection:**     cases where    data           
               Qwen and Gemini       company or                    
               free-tier usage is    client code                   
               already flagged       may be shared                 
               through `isFreeTier`. under weaker                  
               Free tiers may allow  provider                      
               providers to train on terms.                        
               inputs; check each                                  
               provider's terms.                                   

  **B2**       **Approved-tool       Creates an     ✅ Existing            S--M
               policy:** Admins      enforceable    data           
               define which agents   policy rather                 
               and models are        than one that                 
               allowed. Violations   exists only on                
               appear in a list and  paper.                        
               trigger an alert.                                   

  **B3**       **MCP server          MCP servers    ✅ Existing             S
               inventory and         can send data  data           
               allowlist:** List     to third       (`mcpUsage`)   
               every MCP server in   parties. The                  
               use, identify who     relevant data                 
               uses it, and flag     is already                    
               unapproved servers.   collected                     
                                     through                       
                                     `mcpUsage`.                   

  **B4**       **Permission-mode     Shows where    🟡 Transcript          S--M
               audit:** Show the     Claude runs    field          
               share of sessions     shell commands                
               using                 without                       
               `bypassPermissions`   asking. Use                   
               per team.             this to set                   
                                     policy (for                   
                                     example,                      
                                     allowing it                   
                                     only in                       
                                     containers),                  
                                     not to punish                 
                                     developers.                   

  **B5**       **Version             Helps ensure   🟡 `version`            S
               compliance:** Track   security fixes                
               the Claude Code       reach every                   
               version per device    machine.                      
               and flag outdated                                   
               versions.                                           

  **B6**       **Account check:**    Detects work   🟡 Transcript           M
               Map `accountUuid`     performed from field          
               (hashed on the        personal                      
               device) to assigned   accounts and                  
               seats.                one seat                      
                                     shared by                     
                                     several                       
                                     people.                       

  **B7**       **Per-client AI       Turns AI       ⚪ Admin                M
               policy:** Define      restrictions   input + C1     
               rules such as "Client in client                     
               X: no AI" or "Client  contracts into                
               Y: Claude only".      enforceable                   
               Combine C1 with B2.   checks.                       

  **B8**       **Admin audit log:**  Ensures the    New data               S--M
               Record who approved   governance                    
               devices, changed      tool itself is                
               roles, and viewed     subject to                    
               whose data.           oversight.                    

  **B9**       **Retention policy:** Improves       ---                     S
               Automatically delete  privacy                       
               enrichment data older hygiene and                   
               than a configured     developer                     
               number of months.     trust.                        
  -------------------------------------------------------------------------------------

### C. Team and Client Attribution

  --------------------------------------------------------------------------------------------------
  ID           Use case                       Value              Data source /          Size
                                                                 dependency     
  ------------ ------------------------------ ------------------ -------------- --------------------
  **C1**       **Client registry:** Admins    Foundation for     Requires the            M
               map Git remote patterns (for   every              path-privacy   
               example,                       client-related     change         
               `github.com/<client-org>/*`)   feature below.                    
               to a client and project.                                         

  **C2**       **Monthly report per client:** Provides material  After C1                M
               Report active developers,      for client                        
               sessions, value, tools used,   conversations                     
               and policy compliance. Support about AI-assisted                 
               CSV or PDF export.             delivery.                         

  **C3**       **Seat-cost allocation:**      Shows the real AI  After C1                S
               Split the fixed seat bill      cost per client or                
               across clients according to    project.                          
               usage share.                                                     

  **C4**       **Ticket attribution:**        Provides finer     🟡 `gitBranch`          M
               Extract ticket keys from       attribution than                  
               `gitBranch` (for example,      repository-level                  
               `PROJ-123-...`) to calculate   reporting.                        
               usage per ticket or epic. A                                      
               Jira integration can be added                                    
               later.                                                           

  **C5**       **Team dashboards:** Scope     Provides the views Delivered with          M
               Overview and Trends to a team  managers actually  Teams          
               and support team-versus-team   need.                             
               comparisons.                                                     
  --------------------------------------------------------------------------------------------------

### D. Creative Extras

  ------------------------------------------------------------------------
  ID                  Use case                          Size
  ------------------- ------------------- --------------------------------
  **D1**              **AI Wrapped:** A                  M
                      monthly or yearly   
                      personal recap      
                      showing top         
                      project, favorite   
                      tools, streak, new  
                      features tried, and 
                      value multiple.     
                      Make it shareable   
                      to encourage        
                      adoption.           

  **D2**              **Weekly digest                    M
                      bot:** Send a team  
                      summary to each     
                      manager and         
                      personal stats plus 
                      one tip to each     
                      developer.          

  **D3**              **Seat simulator:**            M after A2
                      Model a plan        
                      change, such as:    
                      "Move these 6       
                      developers down a   
                      tier: save          
                      \$X/month, but 1 of 
                      them would hit      
                      limits about twice  
                      a week."            

  **D4**              **Anomaly flags:**                S--M
                      Detect a sudden     
                      usage drop          
                      (developer stuck or 
                      agent broken) or a  
                      spike on one        
                      account across      
                      several devices     
                      (possible shared    
                      credentials).       

  **D5**              **Team starter                     M
                      kit:** Use A6 data  
                      to recommend an MCP 
                      and skills set for  
                      a shared `.claude/` 
                      configuration.      

  **D6**              **Onboarding                       S
                      success score:**    
                      Measure whether a   
                      new joiner becomes  
                      weekly active and   
                      tries 2+ features   
                      within 14 days.     
  ------------------------------------------------------------------------

## 4. Suggested Implementation Order

1.  **Resolve blockers:** Relabel dollar figures as value; implement
    teams and manager scope; apply path privacy; add SSO and the
    transparency page; move to Vercel Pro.
2.  **Deliver quick wins using existing data:** B1, B3, A1, A3, and A8.
3.  **Release an agent update that reads all 🟡 fields:** Developers
    update once. This enables A5, B4, B5, B6, and C4.
4.  **Add a notification channel:** Enables A4 and D2.
5.  **Build the client registry:** Enables C1--C3 and B7.
6.  **Consider extras:** D1 and D3.

## 5. Open Questions

-   Should notifications use Slack or Microsoft Teams?
-   Should SSO use Google or Microsoft?
-   Which Claude plan tiers are in use, and what is the per-seat price
    for each? A1, A2, and D3 depend on this information.

## 6. Review Status and Next Step

**Completed** - Reviewed the codebase, roadmap, and tickets. - Checked
which fields are available in local Claude transcripts. - Prepared this
proposal based on the four answers provided.

**Remaining** - Select which items should be built. - For each selected
item, prepare an implementation approach and a short design before
writing code.

**Next session goal:** Design the Phase 0 **Teams + manager scope**
change.

### Next Prompt

> BurnWatch rollout: design teams + manager scope. Managers see named
> data for their team only, developers see their own data, and admins
> see all data. Extend `viewerScope` in `apps/api`, add `teams` and
> `team_members` schemas, and implement team-scoped dashboard views.
> Keep the seat-billing context in mind: relabel `$` as "API-equivalent
> value".

------------------------------------------------------------------------

## 7. Seat-Billing Design Proposal

The design document is ready for review at:

`docs/superpowers/specs/2026-11-16-seat-billing-design.md`

It has **not been committed**.

### What Gets Built

-   **Seats:** Add a `seats` table with one row per user, agent, and
    monthly price, including a start date. Admins manage seats in a new
    **Seats** section on the Admin page. If a user has no seat for an
    agent, that agent's usage is treated as API-key usage.
-   **Leaderboard:** Label the dollar figure as **Value** (API
    list-price equivalent). Add columns for actual cost (seat cost plus
    API spend) and value multiple.
-   **Overview:** Add **Value received** and **Actual cost** tiles, with
    a breakdown hint such as `12 seats × $30/mo + $X API`.
-   **Alerts:** Add a type field with three categories: API-key spend,
    idle seat, or limit hit. Spend alerts count only usage not covered
    by a seat.
-   **Agent:** Count usage-limit hits from Claude transcripts,
    deduplicated by message text. This requires a new agent build; older
    agents continue to work.

### Design Decisions to Review

1.  **Seat cost is prorated by day.** It counts only days between the
    seat's start date and today. This avoids charging current seats
    across the entire "All time" range, which starts on `2020-01-01`.
    Without a start date, seats could appear to have been billed for
    approximately seven years. The form defaults the start date to the
    first day of the current month.
2.  **"Assign to everyone" is non-destructive.** It fills only users who
    do not already have a seat and never overwrites existing rows. This
    preserves custom prices, such as Premium pricing. Re-run it when
    someone joins.
3.  **Seat changes re-check spend alerts.** Adding or removing a seat
    triggers a re-check of the organization's spend alerts because it
    changes which usage counts as API spend.
4.  **Seat count means seat rows.** One person with Claude and Copilot
    has two seats. Seats belonging to deactivated users continue to cost
    money until removed; the idle-seat alert flags them.
5.  **Idle seats are checked per agent.** A Claude seat is idle when
    there have been no Claude tokens for the configured number of days.
6.  **Limit-hit tracking is Claude-only.** Existing days show `0` until
    developers re-sync using the new agent. There is no server-side
    backfill.
7.  **Terminology is updated consistently.** Rename "spend" on Trends,
    Projects, and the Admin team table as well. These are the same
    conceptual issue and each fix is a string edit.

### Known Limitations

-   A seat has no end date.
-   Usage from before a seat's start date still counts as seated value.
-   If one developer uses two machines, the machines can overwrite each
    other's limit-hit data. This limitation already applies to every
    enrichment field.
