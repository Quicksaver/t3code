import { MagiParticipantId } from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";

export const makeMobileMagiParticipantId = (): MagiParticipantId =>
  MagiParticipantId.make(`mobile-${uuidv4()}`);
