"use client";

import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@usesend/ui/src/breadcrumb";
import { Button } from "@usesend/ui/src/button";
import { Plus } from "lucide-react";
import TopicDialog from "./topic-dialog";
import TopicList from "./topic-list";

export default function TopicsPage() {
  return (
    <div>
      <div className="flex justify-between items-center">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/contacts" className="text-xl">
                  Contact books
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-xl" />
            <BreadcrumbItem>
              <BreadcrumbPage className="text-xl">Topics</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <TopicDialog
          trigger={
            <Button>
              <Plus className="h-4 w-4 mr-1" />
              Add topic
            </Button>
          }
        />
      </div>
      <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
        Topics are subscription categories across every contact book in this
        team. Public topics show up on the recipient preference page linked
        from every unsubscribe link, so a recipient can opt out of just one
        kind of email instead of all of them.
      </p>
      <TopicList />
    </div>
  );
}
