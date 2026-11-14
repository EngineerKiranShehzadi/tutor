import { gql } from '@apollo/client';

export const GET_COURSE_MISCONCEPTIONS = gql`
 query CourseMisconceptions($courseId:Int!) {
  courseMisconceptions(courseId:$courseId) {id outcomeId code description}
 }
`;
export const GET_MISCONCEPTION_REVIEW = gql`
 query MisconceptionQuestionReview($courseId:Int!,$limit:Int) {
  misconceptionQuestionReview(courseId:$courseId,limit:$limit) {
    questionId question options correctIndex outcomeId mappings {optionIndex misconceptionId}
  }
 }
`;
export const GET_MY_MISCONCEPTION_EVIDENCE = gql`
 query MyMisconceptionEvidence($courseId:Int!) {
  myMisconceptionEvidence(courseId:$courseId) {
   id outcomeId outcomeCode code description occurrences attempts repeated lastSeen
  }
 }
`;
export const GET_MY_OUTCOME_TIMELINE = gql`
 query MyOutcomeTimeline($courseId:Int!) {
  myOutcomeTimeline(courseId:$courseId) {
   outcomeId code quizId submittedAt attempted correct
  }
 }
`;
export const CREATE_MISCONCEPTION = gql`
 mutation CreateMisconception($courseId:Int!,$outcomeId:Int!,$code:String!,$description:String!) {
  createMisconception(courseId:$courseId,outcomeId:$outcomeId,code:$code,description:$description) {
   id outcomeId code description
  }
 }
`;
export const SET_DISTRACTOR_MISCONCEPTION = gql`
 mutation SetDistractorMisconception($courseId:Int!,$questionId:Int!,$optionIndex:Int!,$misconceptionId:Int) {
  setDistractorMisconception(courseId:$courseId,questionId:$questionId,optionIndex:$optionIndex,misconceptionId:$misconceptionId)
 }
`;
