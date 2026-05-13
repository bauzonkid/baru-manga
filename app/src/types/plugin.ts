export interface SourceInfo {
  id: string
  name: string
  capabilities: {
    search: boolean
    openLocal: boolean
  }
  needsApiKey?: boolean
}

export interface MangaResult {
  id: string
  title: string
  cover?: string
  description?: string
  tags?: string[]
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown'
  contentRating?: string
  authors?: string[]
  artists?: string[]
  altTitles?: string[]
}

export interface Chapter {
  id: string
  number: string
  title?: string
  language: string
  pageCount?: number
  publishedAt?: string
  scanlationGroup?: string
}

export interface Page {
  url: string
  index: number
}

export interface ReviewRequest {
  pages: string[]
  language: 'vi' | 'th' | 'en' | 'ko' | 'ja'
  style: 'recap' | 'review'
  mangaTitle?: string
  chapterTitle?: string
}

export type ReviewLanguage = ReviewRequest['language']
export type ReviewStyle = ReviewRequest['style']
