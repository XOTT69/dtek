import { GROUPS } from './schedule.mjs';

// The water bot's public source-of-truth is independent of successful
// Telegram posts and of correction baseline snapshots.
export function confirmedDayForSync(byGroup) {
  if (!GROUPS.every(group=>byGroup?.[group]?.mode==='fact'))return null;
  const result={};
  for(const group of GROUPS) {
    const windows=byGroup[group].confirmed;
    if(!Array.isArray(windows))return null;
    const pairs=[];
    let endPrevious=0;
    for(const window of windows) {
      const {start,end}=window||{};
      if(!Number.isInteger(start)||!Number.isInteger(end)||
        start<endPrevious||start<0||end>1440||end<=start||
        start%30!==0||end%30!==0)return null;
      pairs.push([start,end]);
      endPrevious=end;
    }
    result[group]=pairs;
  }
  return result;
}

export function recordConfirmedDay(state,date,byGroup) {
  const snapshot=confirmedDayForSync(byGroup);
  if(!snapshot)return false;
  state.confirmedSchedules ??= {};
  if(JSON.stringify(state.confirmedSchedules[date])===JSON.stringify(snapshot))
    return false;
  state.confirmedSchedules[date]=snapshot;
  return true;
}
