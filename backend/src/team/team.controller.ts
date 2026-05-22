import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { User } from "@prisma/client";
import { TeamService } from "./team.service";
import {
  CreateTeamDTO,
  UpdateTeamDTO,
  InviteMemberDTO,
  UpdateMemberRoleDTO,
  CreateFolderDTO,
  SetFolderAccessDTO,
  SetFileAccessDTO,
  BulkDeleteFilesDTO,
  AdminCreateTeamDTO,
  AdminAddMemberDTO,
  AdminSetRoleDTO,
  AdminSetMaxMembersDTO,
  CreateGuestLinkDTO,
} from "./dto/team.dto";

@Controller("teams")
export class TeamController {
  constructor(private teamService: TeamService) {}

  // =========================================================================
  // TEAM CRUD
  // =========================================================================

  @Post()
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 3, ttl: 3600 } })
  create(@Body() dto: CreateTeamDTO, @GetUser() user: User) {
    return this.teamService.createTeam(dto, user);
  }

  @Get()
  @UseGuards(JwtGuard)
  getMyTeams(@GetUser() user: User) {
    return this.teamService.getMyTeams(user.id);
  }

  @Get("status")
  @UseGuards(JwtGuard)
  getTeamStatus(@GetUser() user: User) {
    if (!user?.id) throw new UnauthorizedException();
    return this.teamService.getTeamStatus(user.id);
  }

  @Get("signable-files")
  @UseGuards(JwtGuard)
  getSignableFiles(@GetUser() user: User) {
    return this.teamService.getSignableFiles(user.id);
  }

  // =========================================================================
  // PLATFORM ADMIN ROUTES (must be before :teamId param routes)
  // =========================================================================

  @Get("admin/all")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminListAllTeams() {
    return this.teamService.adminListAllTeams();
  }

  @Post("admin/create")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminCreateTeam(@Body() dto: AdminCreateTeamDTO) {
    return this.teamService.adminCreateTeam(dto);
  }

  @Post("admin/:teamId/join")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminJoinTeam(@Param("teamId") teamId: string, @GetUser() user: User) {
    return this.teamService.adminJoinTeam(teamId, user.id);
  }

  @Post("admin/:teamId/add-member")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminAddMember(
    @Param("teamId") teamId: string,
    @Body() dto: AdminAddMemberDTO,
  ) {
    return this.teamService.adminAddUserToTeam(teamId, dto.userId, dto.role);
  }

  @Patch("admin/:teamId/members/:memberId/role")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminSetMemberRole(
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @Body() dto: AdminSetRoleDTO,
  ) {
    return this.teamService.adminAddUserToTeam(teamId, memberId, dto.role);
  }

  @Patch("admin/:teamId/members/:memberId/set-admin")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminDesignateTeamAdmin(
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
  ) {
    return this.teamService.adminSetTeamAdmin(teamId, memberId);
  }

  @Patch("admin/:teamId/max-members")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminSetMaxMembers(
    @Param("teamId") teamId: string,
    @Body() dto: AdminSetMaxMembersDTO,
  ) {
    return this.teamService.adminSetTeamMaxMembers(teamId, dto.maxMembers);
  }

  @Get("admin/:teamId")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminGetTeam(@Param("teamId") teamId: string) {
    return this.teamService.adminGetTeamDetails(teamId);
  }

  @Patch("admin/:teamId")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminUpdateTeam(
    @Param("teamId") teamId: string,
    @Body() dto: UpdateTeamDTO,
  ) {
    return this.teamService.adminUpdateTeam(teamId, dto);
  }

  @Delete("admin/:teamId")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminDeleteTeam(@Param("teamId") teamId: string) {
    return this.teamService.adminDeleteTeam(teamId);
  }

  @Delete("admin/:teamId/members/:memberId")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminRemoveMember(
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
  ) {
    return this.teamService.adminRemoveMember(teamId, memberId);
  }

  @Get("admin/:teamId/folders")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminGetFolders(@Param("teamId") teamId: string) {
    return this.teamService.adminGetFolders(teamId);
  }

  @Patch("admin/:teamId/folders/:folderId")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminUpdateFolder(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @Body() body: { name?: string },
  ) {
    return this.teamService.adminUpdateFolder(teamId, folderId, body);
  }

  @Delete("admin/:teamId/folders/:folderId")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminDeleteFolder(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
  ) {
    return this.teamService.adminDeleteFolder(teamId, folderId);
  }

  @Get("admin/:teamId/folders/:folderId/files")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminGetFolderFiles(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
  ) {
    return this.teamService.adminGetFolderFiles(teamId, folderId);
  }

  @Delete("admin/:teamId/files/:fileId")
  @UseGuards(JwtGuard, AdministratorGuard)
  adminDeleteFile(
    @Param("teamId") teamId: string,
    @Param("fileId") fileId: string,
  ) {
    return this.teamService.adminDeleteFile(teamId, fileId);
  }

  // =========================================================================
  // TEAM CRUD (parameterized routes)
  // =========================================================================

  @Get(":teamId")
  @UseGuards(JwtGuard)
  getTeam(@Param("teamId") teamId: string, @GetUser() user: User) {
    return this.teamService.getTeam(teamId, user.id);
  }

  @Patch(":teamId")
  @UseGuards(JwtGuard)
  updateTeam(
    @Param("teamId") teamId: string,
    @Body() dto: UpdateTeamDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.updateTeam(teamId, dto, user.id);
  }

  @Delete(":teamId")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 2, ttl: 86400 } })
  deleteTeam(
    @Param("teamId") teamId: string,
    @Body() body: { confirmationName?: string },
    @GetUser() user: User,
  ) {
    return this.teamService.deleteTeam(teamId, user.id, body.confirmationName);
  }

  // =========================================================================
  // MEMBER MANAGEMENT
  // =========================================================================

  @Post(":teamId/members/invite")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  inviteMember(
    @Param("teamId") teamId: string,
    @Body() dto: InviteMemberDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.inviteMember(teamId, dto, user.id);
  }

  @Post("invite/:token/accept")
  @UseGuards(JwtGuard)
  acceptInvitation(
    @Param("token") token: string,
    @Body() body: { wrappedTeamKey?: string },
    @GetUser() user: User,
  ) {
    return this.teamService.acceptInvitation(token, user.id, body.wrappedTeamKey);
  }

  // =========================================================================
  // TEAM E2E KEY MANAGEMENT
  // =========================================================================

  @Get(":teamId/team-key")
  @UseGuards(JwtGuard)
  getTeamKey(@Param("teamId") teamId: string, @GetUser() user: User) {
    return this.teamService.getTeamKey(teamId, user.id);
  }

  @Put(":teamId/team-key")
  @UseGuards(JwtGuard)
  setTeamKey(
    @Param("teamId") teamId: string,
    @Body() body: { wrappedTeamKey: string },
    @GetUser() user: User,
  ) {
    return this.teamService.setTeamKey(teamId, user.id, body.wrappedTeamKey);
  }

  @Get(":teamId/shares")
  @UseGuards(JwtGuard)
  getTeamShares(@Param("teamId") teamId: string, @GetUser() user: User) {
    return this.teamService.getTeamShares(teamId, user.id);
  }

  @Post(":teamId/rotate-team-key")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 5, ttl: 3600 } })
  rotateTeamKey(
    @Param("teamId") teamId: string,
    @Body() body: { newWrappedTeamKey: string },
    @GetUser() user: User,
  ) {
    return this.teamService.rotateTeamKey(teamId, user.id, body.newWrappedTeamKey);
  }

  @Delete(":teamId/members/:memberId")
  @UseGuards(JwtGuard)
  removeMember(
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.removeMember(teamId, memberId, user.id);
  }

  @Post(":teamId/leave")
  @UseGuards(JwtGuard)
  leaveTeam(@Param("teamId") teamId: string, @GetUser() user: User) {
    return this.teamService.leaveTeam(teamId, user.id);
  }

  @Get(":teamId/members/:memberId/folder-access")
  @UseGuards(JwtGuard)
  getMemberFolderAccess(
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.getMemberFolderAccess(teamId, memberId, user.id);
  }

  @Patch(":teamId/members/:memberId/role")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  updateMemberRole(
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @Body() dto: UpdateMemberRoleDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.updateMemberRole(teamId, memberId, dto.role, user.id);
  }

  @Patch(":teamId/members/:memberId/permissions")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  updateMemberPermissions(
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @Body() dto: { canViewActivity?: boolean; canViewSignatures?: boolean },
    @GetUser() user: User,
  ) {
    return this.teamService.updateMemberPermissions(
      teamId,
      memberId,
      dto,
      user.id,
    );
  }

  // =========================================================================
  // FOLDERS
  // =========================================================================

  @Post(":teamId/folders")
  @UseGuards(JwtGuard)
  createFolder(
    @Param("teamId") teamId: string,
    @Body() dto: CreateFolderDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.createFolder(teamId, dto, user.id);
  }

  @Get(":teamId/folders")
  @UseGuards(JwtGuard)
  getFolders(
    @Param("teamId") teamId: string,
    @Query("parentId") parentId: string | undefined,
    @GetUser() user: User,
  ) {
    return this.teamService.getFolders(teamId, user.id, parentId);
  }

  @Post(":teamId/folders/:folderId/access")
  @UseGuards(JwtGuard)
  setFolderAccess(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @Body() dto: SetFolderAccessDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.setFolderAccess(teamId, folderId, dto, user.id);
  }

  @Get(":teamId/folders/:folderId/access")
  @UseGuards(JwtGuard)
  getFolderAccess(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.getFolderAccess(teamId, folderId, user.id);
  }

  @Delete(":teamId/folders/:folderId/access/:memberId")
  @UseGuards(JwtGuard)
  removeFolderAccess(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @Param("memberId") memberId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.removeFolderAccess(teamId, folderId, memberId, user.id);
  }

  @Delete(":teamId/folders/:folderId")
  @UseGuards(JwtGuard)
  deleteFolder(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @Body() body: { confirmationName?: string },
    @GetUser() user: User,
  ) {
    return this.teamService.deleteFolder(teamId, folderId, user.id, body.confirmationName);
  }

  @Get(":teamId/folders/:folderId/shares")
  @UseGuards(JwtGuard)
  getFolderShares(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.getFolderShares(teamId, folderId, user.id);
  }

  // =========================================================================
  // FILE-LEVEL ACCESS (per-file granular permissions for team members)
  // =========================================================================

  @Post(":teamId/folders/:folderId/file-access")
  @UseGuards(JwtGuard)
  setFileAccess(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @Body() dto: SetFileAccessDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.setFileAccess(teamId, folderId, dto, user.id);
  }

  @Get(":teamId/folders/:folderId/file-access")
  @UseGuards(JwtGuard)
  getFileAccess(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.getFileAccess(teamId, folderId, user.id);
  }

  @Post(":teamId/folders/:folderId/bulk-delete")
  @UseGuards(JwtGuard)
  bulkDeleteFiles(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @Body() dto: BulkDeleteFilesDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.bulkDeleteFiles(teamId, folderId, dto, user.id);
  }

  // =========================================================================
  // GUEST LINKS (competitive feature: share folders externally)
  // =========================================================================

  @Post(":teamId/folders/:folderId/guest-links")
  @UseGuards(JwtGuard)
  createGuestLink(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @Body() dto: CreateGuestLinkDTO,
    @GetUser() user: User,
  ) {
    return this.teamService.createGuestLink(teamId, folderId, dto, user.id);
  }

  @Get(":teamId/folders/:folderId/guest-links")
  @UseGuards(JwtGuard)
  getGuestLinks(
    @Param("teamId") teamId: string,
    @Param("folderId") folderId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.getGuestLinks(teamId, folderId, user.id);
  }

  @Delete(":teamId/guest-links/:linkId")
  @UseGuards(JwtGuard)
  revokeGuestLink(
    @Param("teamId") teamId: string,
    @Param("linkId") linkId: string,
    @GetUser() user: User,
  ) {
    return this.teamService.revokeGuestLink(teamId, linkId, user.id);
  }

  // =========================================================================
  // METRICS & LOGS
  // =========================================================================

  @Get(":teamId/metrics")
  @UseGuards(JwtGuard)
  getMetrics(@Param("teamId") teamId: string, @GetUser() user: User) {
    return this.teamService.getMetrics(teamId, user.id);
  }

  @Get(":teamId/logs")
  @UseGuards(JwtGuard)
  getAccessLogs(
    @Param("teamId") teamId: string,
    @Query("page") page: string,
    @Query("limit") limit: string,
    @Query("action") action: string,
    @GetUser() user: User,
  ) {
    return this.teamService.getAccessLogs(teamId, user.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      action: action || undefined,
    });
  }
}
