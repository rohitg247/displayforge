from pydantic import BaseModel
from typing import Optional


# --- Auth ---
class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    token: str
    user: dict


# --- Branch ---
class BranchCreate(BaseModel):
    name: str


class BranchUpdate(BaseModel):
    name: str


class BranchOut(BaseModel):
    id: int
    name: str
    display_count: int = 0


# --- Display ---
class DisplayCreate(BaseModel):
    branch_id: int
    name: str


class DisplayUpdate(BaseModel):
    name: str


class DisplayOut(BaseModel):
    id: int
    branch_id: int
    name: str
    case_study_count: int = 0


# --- Case Study ---
class CaseStudyCreate(BaseModel):
    display_id: int
    category: str = ""
    title: str
    bullet_points: list[str] = []


class CaseStudyUpdate(BaseModel):
    category: Optional[str] = None
    title: Optional[str] = None
    bullet_points: Optional[list[str]] = None
    is_published: Optional[int] = None


class CaseStudyOut(BaseModel):
    id: int
    display_id: int
    category: str
    title: str
    bullet_points: list[str]
    thumbnails: list[str]
    main_image: Optional[str]
    sort_order: int
    is_published: int = 0


# --- Ambient Display ---
class AmbientDisplayCreate(BaseModel):
    branch_id: int
    name: str
    orientation: str = "landscape"


class AmbientDisplayUpdate(BaseModel):
    name: Optional[str] = None
    orientation: Optional[str] = None
    active_playlist: Optional[str] = None
    announcement_label: Optional[str] = None
    announcement_name: Optional[str] = None
    announcement_title: Optional[str] = None
    announcement_enabled: Optional[int] = None


class AmbientDisplayOut(BaseModel):
    id: int
    branch_id: int
    name: str
    orientation: str
    active_playlist: str = "A"
    announcement_label: str = "Actis welcomes"
    announcement_name: str = ""
    announcement_title: str = ""
    announcement_enabled: int
    media_count: int = 0


# class AmbientMediaOut(BaseModel):
#     id: int
#     ambient_display_id: int
#     file_path: str
#     media_type: str
#     playlist: str = "A"
#     sort_order: int

class AmbientMediaOut(BaseModel):
    id: int
    ambient_display_id: int
    file_path: str
    media_type: str
    playlist: str = "A"
    sort_order: int
    status: str = "draft"          # ← add this line
    poster_path: Optional[str] = None   # last-frame JPEG for video->video swap cover
    duration: Optional[int] = None      # per-image on-screen seconds (NULL = default); ignored for video


class PublishPlaylistRequest(BaseModel):     # ← add entire new class
    playlist: str


class MediaReorderRequest(BaseModel):
    media_ids: list[int]


class ActivePlaylistRequest(BaseModel):
    playlist: str
