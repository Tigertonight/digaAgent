import TaskWorkbench from "./TaskWorkbench";
import { UiFaultBoundary } from "../components/UiFaultBoundary";

export const dynamic = "force-dynamic";

export default function TasksPage() {
  return (
    <UiFaultBoundary surface="TaskWorkbench">
      <TaskWorkbench />
    </UiFaultBoundary>
  );
}
