"use client";

import InviteTeamMember from "./invite-team-member";
import TeamMembersList from "./team-members-list";
import SendingPoolSettings from "./sending-pool-settings";

export default function TeamsPage() {
  return (
    <div>
      <div className="flex justify-end ">
        <InviteTeamMember />
      </div>
      <TeamMembersList />
      <SendingPoolSettings />
    </div>
  );
}
